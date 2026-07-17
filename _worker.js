/**
 * cf-proxy — 基于 Cloudflare Workers/Pages 的 GitHub、GitLab 和 Docker 加速服务
 *
 * 部署方式：
 *   1. Cloudflare Workers: 将本文件粘贴到 Worker 编辑器中部署
 *   2. Cloudflare Pages:   上传本文件到 Pages 项目，入口为 _worker.js
 *
 * 使用方式：
 *   GitHub 文件下载: https://your-domain/https://github.com/user/repo/releases/download/v1.0/file
 *   Git Clone:       git clone https://your-domain/https://github.com/user/repo.git
 *   Docker 拉取:      docker pull your-domain/nginx
 */

// ============================================================
// 默认配置 — 可通过环境变量覆盖
// 环境变量:
//   ALLOWED_HOSTS  — 逗号分隔的额外白名单域名，会与默认白名单合并
//   MAX_REDIRECTS  — 最大重定向次数 (默认 5)
// ============================================================

// 默认白名单域名
const DEFAULT_ALLOWED_HOSTS = [
  // GitHub
  'github.com',
  'raw.githubusercontent.com',
  'gist.github.com',
  'gist.githubusercontent.com',
  'codeload.github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'githubusercontent.com',
  // GitLab
  'gitlab.com',
  'gitlab.freedesktop.org',
  'gitlab.gnome.org',
  'gitlab.kitware.com',
  'gitlab.archlinux.org',
  'gitlab.postmarketos.org',
  // Docker
  'registry-1.docker.io',
  'auth.docker.io',
  'ghcr.io',
  'gcr.io',
  'k8s.gcr.io',
  'registry.k8s.io',
  'quay.io',
  'production.cloudflare.docker.com',
  // AWS S3 (Docker blob 存储)
  'amazonaws.com',
];

// Docker Hub 的认证服务
const DOCKER_AUTH_HOST = 'auth.docker.io';
const DOCKER_REGISTRY_HOST = 'registry-1.docker.io';
const DEFAULT_MAX_REDIRECTS = 5;

// 从环境变量解析配置，未设置时使用默认值
function resolveAllowedHosts(env) {
  const extraHosts = env?.ALLOWED_HOSTS;
  if (!extraHosts) return DEFAULT_ALLOWED_HOSTS;
  const parsed = extraHosts
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(h => h.length > 0);
  // 合并默认白名单与额外域名，去重
  return [...new Set([...DEFAULT_ALLOWED_HOSTS, ...parsed])];
}

function resolveMaxRedirects(env) {
  const val = env?.MAX_REDIRECTS;
  if (val === undefined || val === null || val === '') return DEFAULT_MAX_REDIRECTS;
  const num = parseInt(val, 10);
  return Number.isNaN(num) ? DEFAULT_MAX_REDIRECTS : num;
}

// Git smart-http 协议相关域名
const GIT_DOMAINS = [
  'github.com', 'api.github.com', 'raw.githubusercontent.com',
  'gist.github.com', 'gist.githubusercontent.com', 'codeload.github.com',
  'objects.githubusercontent.com', 'githubusercontent.com',
  'gitlab.com', 'gitlab.freedesktop.org', 'gitlab.gnome.org',
  'gitlab.kitware.com', 'gitlab.archlinux.org', 'gitlab.postmarketos.org',
];

// 需要清理的 Cloudflare 添加的请求头
const CF_HEADERS_TO_REMOVE = [
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
  'cf-worker', 'x-forwarded-for', 'x-real-ip', 'x-forwarded-proto',
  'x-forwarded-host', 'x-amz-content-sha256', 'x-amz-date',
  'x-amz-security-token', 'x-amz-user-agent',
];

// 空请求体的 SHA256 哈希值 (AWS S3 需要)
const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// ============================================================
// 主入口 — Cloudflare Workers/Pages 标准 fetch handler
// ============================================================
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  },
};

// ============================================================
// 核心路由分发
// ============================================================
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, '');

  try {
    // 根路径 → 返回首页 HTML
    if (path === '' || path === '/') {
      return new Response(HOMEPAGE_HTML, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    // Docker Registry V2 API 请求: /v2/...
    if (path.startsWith('v2/')) {
      return await handleDockerV2(request, path, env);
    }

    // 带完整 URL 前缀的请求: /https://github.com/...
    if (path.startsWith('https://') || path.startsWith('http://')) {
      return await handleProxyWithUrl(request, path, env);
    }

    // 裸路径 → 视为 Docker Hub 镜像
    return await handleDockerHub(request, path, env);
  } catch (e) {
    // 兜底: 捕获所有未处理异常, 返回友好错误而非 500
    return new Response(`Proxy error: ${e.message || 'Internal error'}`, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

// ============================================================
// Docker Registry V2 API 处理
// 路径格式: /v2/library/nginx/manifests/latest
// ============================================================
async function handleDockerV2(request, path, env) {
  const url = new URL(request.url);
  // /v2/ 后面的路径
  const dockerPath = path.substring(3); // 去掉 "v2/"
  const targetUrl = `https://${DOCKER_REGISTRY_HOST}/v2/${dockerPath}${url.search}`;

  const headers = buildCommonHeaders(request, DOCKER_REGISTRY_HOST);

  // 构建请求选项: GET/HEAD 请求不传 body
  const fetchOptions = {
    method: request.method,
    headers: headers,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    fetchOptions.body = request.body;
  }

  // Docker V2 API 请求不需要跟随重定向（需要手动处理）
  let response = await fetch(targetUrl, fetchOptions);

  // 处理 401 认证 → 获取 Token → 重试
  if (response.status === 401) {
    const token = await getDockerToken(response);
    if (token) {
      const authHeaders = new Headers(headers);
      authHeaders.set('Authorization', `Bearer ${token}`);
      const authFetchOptions = {
        method: request.method,
        headers: authHeaders,
        redirect: 'manual',
      };
      // 认证重试时不再传 body (流已被消耗)
      response = await fetch(targetUrl, authFetchOptions);
    }
  }

  // 处理 302/307 重定向 (Docker blob 分发到 S3)
  response = await handleRedirects(request, response, headers, true, env);

  return buildProxyResponse(response, true);
}

// ============================================================
// Docker Hub 镜像处理
// 输入格式: nginx, library/nginx, user/repo, docker.io/nginx
// ============================================================
async function handleDockerHub(request, path, env) {
  let dockerPath = path;

  // 去掉 docker.io/ 前缀
  if (dockerPath.startsWith('docker.io/')) {
    dockerPath = dockerPath.substring(10);
  }

  // 解析镜像名称: nginx → library/nginx, user/repo → user/repo
  const parts = dockerPath.split('/');
  if (parts.length === 1 && parts[0]) {
    // 单名镜像: nginx → library/nginx
    dockerPath = 'library/' + dockerPath;
  }

  const url = new URL(request.url);
  const targetUrl = `https://${DOCKER_REGISTRY_HOST}/v2/${dockerPath}${url.search}`;

  const headers = buildCommonHeaders(request, DOCKER_REGISTRY_HOST);

  // 构建请求选项: GET/HEAD 请求不传 body
  const fetchOptions = {
    method: request.method,
    headers: headers,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    fetchOptions.body = request.body;
  }

  let response = await fetch(targetUrl, fetchOptions);

  // 处理 401 认证
  if (response.status === 401) {
    const token = await getDockerToken(response);
    if (token) {
      const authHeaders = new Headers(headers);
      authHeaders.set('Authorization', `Bearer ${token}`);
      const authFetchOptions = {
        method: request.method,
        headers: authHeaders,
        redirect: 'manual',
      };
      // 认证重试时不再传 body (流已被消耗)
      response = await fetch(targetUrl, authFetchOptions);
    }
  }

  // 处理重定向
  response = await handleRedirects(request, response, headers, true, env);

  return buildProxyResponse(response, true);
}

// ============================================================
// 带完整 URL 的代理处理
// 路径格式: /https://github.com/user/repo/...
// ============================================================
async function handleProxyWithUrl(request, path, env) {
  let targetUrl;
  try {
    targetUrl = new URL(path);
  } catch {
    return new Response('Error: Invalid URL format.', { status: 400 });
  }

  const targetDomain = targetUrl.hostname;

  // 白名单校验
  if (!isHostAllowed(targetDomain, env)) {
    return new Response(`Error: Domain "${targetDomain}" is not in the allowed list.`, {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const isGit = isGitRequest(request, targetDomain, path);

  if (isGit) {
    // Git smart-http 请求: 用 follow 模式, 清理 CF 头部
    const gitHeaders = buildGitHeaders(request, targetDomain);
    const gitFetchOptions = {
      method: request.method,
      headers: gitHeaders,
      redirect: 'follow',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      gitFetchOptions.body = request.body;
    }
    const response = await fetch(targetUrl.href, gitFetchOptions);
    return buildProxyResponse(response, false);
  }

  // 普通请求: 用 manual 模式拦截重定向
  const headers = buildCommonHeaders(request, targetDomain);
  const fetchOptions = {
    method: request.method,
    headers: headers,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    fetchOptions.body = request.body;
  }

  let response = await fetch(targetUrl.href, fetchOptions);

  // 处理重定向
  response = await handleRedirects(request, response, headers, false, env);

  return buildProxyResponse(response, false);
}

// ============================================================
// 重定向处理 (302/307)
// Docker blob 分发到 S3, GitHub release 到 objects.githubusercontent.com
// ============================================================
async function handleRedirects(request, response, baseHeaders, isDocker, env) {
  let redirectCount = 0;
  const maxRedirects = resolveMaxRedirects(env);

  // 重定向请求不应携带原始 body (GET/HEAD 请求无 body)
  const redirectMethod = (request.method === 'POST' || request.method === 'PUT') ? request.method : 'GET';

  while ((response.status === 302 || response.status === 307 || response.status === 301 || response.status === 308) && redirectCount < maxRedirects) {
    const location = response.headers.get('Location');
    if (!location) break;

    // 解析重定向 URL (支持相对路径和绝对路径)
    let redirectUrl;
    try {
      redirectUrl = new URL(location, `https://${new URL(request.url).hostname}`);
    } catch {
      break;
    }
    const redirectHost = redirectUrl.hostname;

    const redirectHeaders = new Headers(baseHeaders);
    redirectHeaders.set('Host', redirectHost);
    // 重定向请求不携带原始 Referer
    redirectHeaders.set('Referer', `https://${redirectHost}/`);

    // AWS S3 重定向需要补充认证头
    if (isAmazonS3(redirectUrl.href)) {
      redirectHeaders.set('x-amz-content-sha256', EMPTY_BODY_SHA256);
      redirectHeaders.set('x-amz-date', formatAWSDate());
    }

    // 白名单校验
    if (!isHostAllowed(redirectHost, env)) {
      break;
    }

    try {
      response = await fetch(redirectUrl.href, {
        method: redirectMethod,
        headers: redirectHeaders,
        redirect: 'manual',
      });
    } catch (e) {
      break;
    }

    redirectCount++;
  }

  return response;
}

// ============================================================
// Docker Token 认证
// 解析 WWW-Authenticate 头, 获取 Bearer Token
// ============================================================
async function getDockerToken(response) {
  const authHeader = response.headers.get('WWW-Authenticate') || '';
  // 格式: Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"
  const match = authHeader.match(/realm="([^"]+)".*service="([^"]+)".*scope="([^"]+)"/);
  if (!match) return null;

  const [, realm, service, scope] = match;
  const tokenUrl = `${realm}?service=${encodeURIComponent(service)}&scope=${encodeURIComponent(scope)}`;

  try {
    const tokenResponse = await fetch(tokenUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    const tokenData = await tokenResponse.json();
    return tokenData.token || tokenData.access_token || null;
  } catch {
    return null;
  }
}

// ============================================================
// 工具函数
// ============================================================

function isHostAllowed(hostname, env) {
  const allowedHosts = resolveAllowedHosts(env);
  return allowedHosts.some(host => hostname === host || hostname.endsWith('.' + host));
}

function isGitRequest(request, targetDomain, path) {
  const userAgent = (request.headers.get('User-Agent') || '').toLowerCase();

  // Git 客户端的 User-Agent 包含 git/
  if (userAgent.includes('git/')) return true;

  // 检查是否为 Git smart-http 协议路径
  if (GIT_DOMAINS.includes(targetDomain)) {
    if (path.includes('/info/refs') ||
        path.includes('/git-upload-pack') ||
        path.includes('/git-receive-pack') ||
        path.includes('.git')) {
      return true;
    }
  }

  return false;
}

function isAmazonS3(url) {
  try {
    return new URL(url).hostname.includes('amazonaws.com');
  } catch {
    return false;
  }
}

function formatAWSDate() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, -5) + 'Z';
}

function buildCommonHeaders(request, targetDomain) {
  const headers = new Headers(request.headers);
  headers.set('Host', targetDomain);
  headers.set('Referer', `https://${targetDomain}/`);

  // 清理 Cloudflare 添加的头部
  CF_HEADERS_TO_DELETE.forEach(h => headers.delete(h));

  return headers;
}

function buildGitHeaders(request, targetDomain) {
  const headers = new Headers(request.headers);
  headers.set('Host', targetDomain);
  headers.set('Referer', `https://${targetDomain}/`);

  // 清理所有 Cloudflare 和代理相关的头部
  CF_HEADERS_TO_DELETE.forEach(h => headers.delete(h));

  return headers;
}

function buildProxyResponse(response, isDocker) {
  const newResponse = new Response(response.body, response);

  // CORS 头部
  newResponse.headers.set('Access-Control-Allow-Origin', '*');
  newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, HEAD, OPTIONS');
  newResponse.headers.set('Access-Control-Allow-Headers', '*');
  newResponse.headers.set('Access-Control-Expose-Headers', '*');

  if (isDocker) {
    // Docker Registry V2 API 版本标识
    newResponse.headers.set('Docker-Distribution-Api-Version', 'registry/2.0');
    // 删除 Location 头, 避免客户端直接访问原始 URL
    newResponse.headers.delete('Location');
  }

  return newResponse;
}

// ============================================================
// 首页 HTML 界面
// ============================================================
const HOMEPAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CF 加速代理 — GitHub / GitLab / Docker</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            brand: { 50: '#eff6ff', 100: '#dbeafe', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8' }
          }
        }
      }
    }
  </script>
  <style>
    body { transition: background-color 0.3s, color 0.3s; }
    .copy-btn:active { transform: scale(0.95); }
    .fade-in { animation: fadeIn 0.3s ease-in; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-thumb { background: rgba(156,163,175,0.5); border-radius: 3px; }
  </style>
</head>
<body class="bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 min-h-screen">
  <div class="container mx-auto px-4 py-6 max-w-3xl">

    <!-- 头部 -->
    <header class="text-center mb-8">
      <div class="flex items-center justify-center gap-3 mb-2">
        <svg class="w-8 h-8 text-brand-600 dark:text-brand-500" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
        </svg>
        <h1 class="text-2xl font-bold">CF 加速代理</h1>
      </div>
      <p class="text-sm text-gray-500 dark:text-gray-400">GitHub · GitLab · Docker 全站加速服务</p>
    </header>

    <!-- 功能标签页 -->
    <div class="flex flex-wrap gap-2 mb-6 justify-center">
      <button onclick="switchTab('github')" id="tab-github" class="tab-btn px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-brand-600 text-white">
        GitHub / GitLab 文件
      </button>
      <button onclick="switchTab('clone')" id="tab-clone" class="tab-btn px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700">
        Git Clone
      </button>
      <button onclick="switchTab('docker')" id="tab-docker" class="tab-btn px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700">
        Docker 镜像
      </button>
    </div>

    <!-- GitHub / GitLab 文件加速 -->
    <div id="panel-github" class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 mb-4 border border-gray-100 dark:border-gray-700">
      <label class="block text-sm font-medium mb-2">输入 GitHub / GitLab 文件链接</label>
      <input type="text" id="input-github" class="w-full px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent mb-3" placeholder="https://github.com/user/repo/releases/download/v1.0/file.zip" oninput="convertGithub()">
      <div class="flex gap-2 mb-3">
        <button onclick="convertGithub()" class="flex-1 px-4 py-2.5 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-medium transition-colors">转换链接</button>
        <button onclick="copyResult('output-github')" class="copy-btn px-4 py-2.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg text-sm font-medium transition-colors">复制链接</button>
      </div>
      <div class="bg-gray-50 dark:bg-gray-900 rounded-lg p-3">
        <label class="text-xs text-gray-400 mb-1 block">加速链接</label>
        <p id="output-github" class="text-sm font-mono break-all text-brand-600 dark:text-brand-500 min-h-[1.5rem]">等待输入...</p>
      </div>
      <div class="mt-3 text-xs text-gray-400">
        <p>支持: release 下载、raw 文件、gist、codeload zip、GitLab raw 文件</p>
      </div>
    </div>

    <!-- Git Clone 加速 -->
    <div id="panel-clone" class="hidden bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 mb-4 border border-gray-100 dark:border-gray-700">
      <label class="block text-sm font-medium mb-2">输入 Git 仓库地址</label>
      <input type="text" id="input-clone" class="w-full px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent mb-3" placeholder="https://github.com/user/repo.git" oninput="convertClone()">
      <div class="flex gap-2 mb-3">
        <button onclick="convertClone()" class="flex-1 px-4 py-2.5 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-medium transition-colors">生成命令</button>
        <button onclick="copyResult('output-clone')" class="copy-btn px-4 py-2.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg text-sm font-medium transition-colors">复制命令</button>
      </div>
      <div class="bg-gray-50 dark:bg-gray-900 rounded-lg p-3">
        <label class="text-xs text-gray-400 mb-1 block">Clone 命令</label>
        <p id="output-clone" class="text-sm font-mono break-all text-green-600 dark:text-green-400 min-h-[1.5rem]">等待输入...</p>
      </div>
      <div class="mt-3 text-xs text-gray-400">
        <p>支持: GitHub、GitLab 及其他 Git 托管平台仓库</p>
      </div>
    </div>

    <!-- Docker 镜像加速 -->
    <div id="panel-docker" class="hidden bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 mb-4 border border-gray-100 dark:border-gray-700">
      <label class="block text-sm font-medium mb-2">输入 Docker 镜像名称</label>
      <input type="text" id="input-docker" class="w-full px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent mb-3" placeholder="nginx 或 user/repo 或 ghcr.io/user/repo" oninput="convertDocker()">
      <div class="flex gap-2 mb-3">
        <button onclick="convertDocker()" class="flex-1 px-4 py-2.5 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-medium transition-colors">生成命令</button>
        <button onclick="copyResult('output-docker')" class="copy-btn px-4 py-2.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg text-sm font-medium transition-colors">复制命令</button>
      </div>
      <div class="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 mb-3">
        <label class="text-xs text-gray-400 mb-1 block">Docker Pull 命令</label>
        <p id="output-docker" class="text-sm font-mono break-all text-purple-600 dark:text-purple-400 min-h-[1.5rem]">等待输入...</p>
      </div>
      <div class="bg-gray-50 dark:bg-gray-900 rounded-lg p-3">
        <label class="text-xs text-gray-400 mb-1 block">daemon.json 配置 (可选)</label>
        <p id="output-daemon" class="text-xs font-mono break-all text-gray-600 dark:text-gray-400 min-h-[1.5rem]">输入镜像名称后生成</p>
      </div>
      <div class="mt-3 text-xs text-gray-400 space-y-1">
        <p>支持: Docker Hub (nginx)、GHCR (ghcr.io/...)、GCR (gcr.io/...)、Quay (quay.io/...)</p>
      </div>
    </div>

    <!-- 使用说明 -->
    <details class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-4 border border-gray-100 dark:border-gray-700 mb-4">
      <summary class="text-sm font-medium cursor-pointer select-none">📖 使用说明</summary>
      <div class="mt-3 text-sm text-gray-600 dark:text-gray-400 space-y-3">
        <div>
          <h3 class="font-semibold text-gray-800 dark:text-gray-200 mb-1">GitHub 文件下载</h3>
          <p>将原始链接前加上代理域名即可加速下载：</p>
          <code class="block mt-1 text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded">https://your-domain/https://github.com/user/repo/releases/download/v1.0/file</code>
        </div>
        <div>
          <h3 class="font-semibold text-gray-800 dark:text-gray-200 mb-1">Git Clone 加速</h3>
          <p>在仓库 URL 前加上代理域名：</p>
          <code class="block mt-1 text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded">git clone https://your-domain/https://github.com/user/repo.git</code>
        </div>
        <div>
          <h3 class="font-semibold text-gray-800 dark:text-gray-200 mb-1">Docker 镜像加速</h3>
          <p>方式一 — 直接拉取：</p>
          <code class="block mt-1 text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded">docker pull your-domain/nginx</code>
          <p class="mt-1">方式二 — 配置镜像加速器 (/etc/docker/daemon.json)：</p>
          <code class="block mt-1 text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded">{ "registry-mirrors": ["https://your-domain"] }</code>
        </div>
      </div>
    </details>

    <!-- 暗黑模式切换 -->
    <div class="flex justify-center mb-4">
      <button onclick="toggleTheme()" class="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
        <span id="theme-icon">🌙 暗黑</span>
      </button>
    </div>

    <!-- 页脚 -->
    <footer class="text-center text-xs text-gray-400 dark:text-gray-500">
      <p>基于 Cloudflare Workers/Pages · 仅供学习研究使用</p>
      <p class="mt-1">请遵守相关服务条款，不要用于商业用途</p>
    </footer>
  </div>

  <script>
    // 获取当前域名
    var currentDomain = location.hostname;
    var currentOrigin = location.origin;

    // ============================================================
    // 标签页切换
    // ============================================================
    function switchTab(tab) {
      var tabs = ['github', 'clone', 'docker'];
      tabs.forEach(function(t) {
        var panel = document.getElementById('panel-' + t);
        var btn = document.getElementById('tab-' + t);
        if (t === tab) {
          panel.classList.remove('hidden');
          btn.classList.remove('bg-white', 'dark:bg-gray-800', 'text-gray-700', 'dark:text-gray-300', 'border', 'border-gray-200', 'dark:border-gray-700');
          btn.classList.add('bg-brand-600', 'text-white');
        } else {
          panel.classList.add('hidden');
          btn.classList.add('bg-white', 'dark:bg-gray-800', 'text-gray-700', 'dark:text-gray-300', 'border', 'border-gray-200', 'dark:border-gray-700');
          btn.classList.remove('bg-brand-600', 'text-white');
        }
      });
    }

    // ============================================================
    // GitHub / GitLab 文件链接转换
    // ============================================================
    function convertGithub() {
      var input = document.getElementById('input-github').value.trim();
      var output = document.getElementById('output-github');
      if (!input) {
        output.textContent = '等待输入...';
        return;
      }
      // 确保 URL 以 http:// 或 https:// 开头
      if (!/^https?:\\/\\//.test(input)) {
        output.textContent = '❌ 链接必须以 https:// 或 http:// 开头';
        return;
      }
      var result = currentOrigin + '/' + input;
      output.textContent = result;
      output.classList.add('fade-in');
    }

    // ============================================================
    // Git Clone 命令生成
    // ============================================================
    function convertClone() {
      var input = document.getElementById('input-clone').value.trim();
      var output = document.getElementById('output-clone');
      if (!input) {
        output.textContent = '等待输入...';
        return;
      }
      if (!/^https?:\\/\\//.test(input)) {
        output.textContent = '❌ 仓库地址必须以 https:// 或 http:// 开头';
        return;
      }
      var result = 'git clone ' + currentOrigin + '/' + input;
      output.textContent = result;
      output.classList.add('fade-in');
    }

    // ============================================================
    // Docker 镜像命令生成
    // ============================================================
    function convertDocker() {
      var input = document.getElementById('input-docker').value.trim();
      var outputDocker = document.getElementById('output-docker');
      var outputDaemon = document.getElementById('output-daemon');
      if (!input) {
        outputDocker.textContent = '等待输入...';
        outputDaemon.textContent = '输入镜像名称后生成';
        return;
      }

      // 生成 docker pull 命令
      var pullCmd = 'docker pull ' + currentDomain + '/' + input;
      outputDocker.textContent = pullCmd;
      outputDocker.classList.add('fade-in');

      // 生成 daemon.json 配置
      var daemonConfig = JSON.stringify({ 'registry-mirrors': [currentOrigin] }, null, 2);
      outputDaemon.textContent = daemonConfig;
    }

    // ============================================================
    // 剪贴板复制 (兼容 PC + 移动端)
    // ============================================================
    function copyResult(elementId) {
      var element = document.getElementById(elementId);
      var text = element.textContent;

      if (!text || text === '等待输入...' || text.startsWith('❌')) {
        showToast('没有可复制的内容');
        return;
      }

      // 优先使用现代 Clipboard API (需 HTTPS)
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function() {
          showToast('✅ 已复制到剪贴板');
        }).catch(function() {
          fallbackCopy(text);
        });
      } else {
        fallbackCopy(text);
      }
    }

    // 后备复制方案 (兼容非 HTTPS 和老浏览器)
    function fallbackCopy(text) {
      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);

      // iOS Safari 需要先 focus 再 select
      var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      if (isIOS) {
        var range = document.createRange();
        range.selectNodeContents(textarea);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        textarea.setSelectionRange(0, text.length);
      } else {
        textarea.focus();
        textarea.select();
      }

      try {
        var success = document.execCommand('copy');
        if (success) {
          showToast('✅ 已复制到剪贴板');
        } else {
          showToast('❌ 复制失败，请手动复制');
        }
      } catch (e) {
        showToast('❌ 复制失败，请手动复制');
      }

      document.body.removeChild(textarea);
    }

    // ============================================================
    // Toast 提示
    // ============================================================
    function showToast(message) {
      var existing = document.getElementById('toast');
      if (existing) existing.remove();

      var toast = document.createElement('div');
      toast.id = 'toast';
      toast.textContent = message;
      toast.style.cssText = 'position:fixed;bottom:2rem;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.8);color:#fff;padding:0.6rem 1.2rem;border-radius:0.5rem;font-size:0.875rem;z-index:9999;transition:opacity 0.3s;';

      document.body.appendChild(toast);

      setTimeout(function() {
        toast.style.opacity = '0';
        setTimeout(function() { toast.remove(); }, 300);
      }, 2000);
    }

    // ============================================================
    // 暗黑模式切换
    // ============================================================
    function toggleTheme() {
      var html = document.documentElement;
      var icon = document.getElementById('theme-icon');
      if (html.classList.contains('dark')) {
        html.classList.remove('dark');
        icon.textContent = '🌙 暗黑';
        localStorage.setItem('theme', 'light');
      } else {
        html.classList.add('dark');
        icon.textContent = '☀️ 明亮';
        localStorage.setItem('theme', 'dark');
      }
    }

    // 初始化主题
    (function() {
      var savedTheme = localStorage.getItem('theme');
      var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
        document.documentElement.classList.add('dark');
        document.getElementById('theme-icon').textContent = '☀️ 明亮';
      }
    })();
  </script>
</body>
</html>`;
