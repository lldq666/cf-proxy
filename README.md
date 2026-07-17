# CF-Proxy — GitHub / GitLab / Docker 加速服务

> 基于 Cloudflare Workers / Pages 的反向代理服务，通过 Cloudflare 全球边缘网络加速 GitHub/GitLab 仓库克隆、文件下载和 Docker 镜像拉取。

## ✨ 功能特性

- 🚀 **GitHub 加速** — Release 下载、Raw 文件、Gist、Codeload ZIP
- 🐙 **Git Clone 加速** — 支持 GitHub、GitLab 等主流 Git 托管平台
- 🐳 **Docker 镜像加速** — 支持 Docker Hub、GHCR、GCR、Quay
- 🌐 **GitLab 加速** — 支持 gitlab.com 及多个自托管 GitLab 实例
- 📱 **响应式界面** — PC 和移动端（iPhone/Android）完美适配
- 📋 **一键复制** — 兼容主流浏览器的剪贴板复制功能
- 🌓 **暗黑模式** — 支持明暗主题切换，自动跟随系统偏好
- 🔒 **安全白名单** — 域名白名单机制，防止滥用

## 📦 部署方式

### 方式一：Cloudflare Workers（推荐快速部署）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages
2. 点击 **创建 Worker**
3. 将 `_worker.js` 的内容粘贴到编辑器中
4. 点击 **部署**
5. （可选）在 **设置 → 触发器** 中绑定自定义域名

### 方式二：Cloudflare Pages（推荐，支持 Git 自动更新）

1. Fork 本仓库到你的 GitHub 账号
2. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages → **创建** → **Pages** → **连接到 Git**
3. 选择你 Fork 的仓库
4. 构建配置：
   - **框架预设**：无
   - **构建命令**：留空
   - **输出目录**：`/`（根目录）
5. 点击 **保存并部署**
6. （可选）在 **自定义域** 中绑定域名

### 方式三：Wrangler CLI 本地部署

```bash
# 安装依赖
npm install

# 本地开发
npm run dev

# 部署到 Cloudflare
npm run deploy
```

## 📖 使用说明

### GitHub 文件下载加速

将原始链接前面加上你的代理域名即可：

```
# 原始链接
https://github.com/user/repo/releases/download/v1.0/file.zip

# 加速链接
https://your-domain/https://github.com/user/repo/releases/download/v1.0/file.zip
```

支持的 GitHub 域名：
- `github.com`（Release 下载）
- `raw.githubusercontent.com`（原始文件）
- `gist.github.com`（Gist 代码片段）
- `codeload.github.com`（ZIP/Tarball 下载）

### Git Clone 加速

在仓库 URL 前加上代理域名：

```bash
# 原始命令
git clone https://github.com/user/repo.git

# 加速命令
git clone https://your-domain/https://github.com/user/repo.git
```

### Docker 镜像加速

**方式一 — 直接拉取：**

```bash
# 原始命令
docker pull nginx
docker pull ghcr.io/user/repo

# 加速命令
docker pull your-domain/nginx
docker pull your-domain/ghcr.io/user/repo
```

**方式二 — 配置镜像加速器（推荐）：**

编辑 `/etc/docker/daemon.json`（不存在则创建）：

```json
{
  "registry-mirrors": ["https://your-domain"]
}
```

重启 Docker：

```bash
sudo systemctl restart docker
```

配置后所有 `docker pull` 命令都会自动走加速。

### GitLab 加速

```bash
# GitLab 仓库 Clone
git clone https://your-domain/https://gitlab.com/user/repo.git

# GitLab Raw 文件
https://your-domain/https://gitlab.com/user/repo/-/raw/main/file.txt
```

## 🌐 支持的域名白名单

| 分类 | 域名 |
|------|------|
| GitHub | `github.com`, `raw.githubusercontent.com`, `gist.github.com`, `codeload.github.com`, `objects.githubusercontent.com` |
| GitLab | `gitlab.com`, `gitlab.freedesktop.org`, `gitlab.gnome.org`, `gitlab.kitware.com`, `gitlab.archlinux.org`, `gitlab.postmarketos.org` |
| Docker | `registry-1.docker.io`, `auth.docker.io`, `ghcr.io`, `gcr.io`, `registry.k8s.io`, `quay.io` |

如需添加更多域名，可通过环境变量配置（见下方）或编辑 `_worker.js` 中的 `DEFAULT_ALLOWED_HOSTS` 数组。

## ⚙️ 自定义配置

支持通过 Cloudflare 环境变量覆盖默认配置，无需修改代码：

| 环境变量 | 说明 | 默认值 | 示例 |
|----------|------|--------|------|
| `ALLOWED_HOSTS` | 额外添加的白名单域名（逗号分隔），会与默认白名单合并 | 默认白名单 | `myregistry.com,ghcr.example.com` |
| `MAX_REDIRECTS` | 最大重定向跟随次数 | `5` | `3` |

### 设置环境变量

**Cloudflare Workers:**
Dashboard → Workers → 你的 Worker → 设置 → 变量和机密 → 添加变量

**Cloudflare Pages:**
Dashboard → Pages → 你的项目 → 设置 → 环境变量 → 添加变量

**wrangler.toml:**

```toml
[vars]
ALLOWED_HOSTS = "myregistry.com,custom.domain.com"
MAX_REDIRECTS = "3"
```

### 配置示例

- 添加私有 Docker Registry：设置 `ALLOWED_HOSTS = "registry.mycompany.com"`
- 添加多个 GitLab 实例：设置 `ALLOWED_HOSTS = "gitlab.mycompany.com,gitlab2.mycompany.com"`
- 减少重定向深度：设置 `MAX_REDIRECTS = "3"`

> 未设置环境变量时，自动使用内置默认配置，开箱即用。

## 📁 项目结构

```
cf-proxy/
├── _worker.js       # 核心反代逻辑 + 前端界面（单文件部署）
├── wrangler.toml    # Cloudflare Workers/Pages 配置
├── package.json     # 项目元数据
├── LICENSE          # MIT 许可证
└── README.md        # 说明文档
```

## ⚠️ 注意事项

1. **Cloudflare 免费版限制**：每日 100,000 次请求，CPU 时间 10ms/请求。高频使用建议升级付费版或绑定自定义域名。
2. **白名单安全**：项目使用域名白名单机制，防止 Worker 变成开放代理被滥用。
3. **Docker manifest 不可缓存**：镜像 manifest 会更新，缓存会导致拉到旧镜像。本项目不对 manifest 做缓存。
4. **Git 协议处理**：Git smart-http 请求会清理所有 Cloudflare 添加的头部，确保 Git 协议正常工作。
5. **大文件下载**：响应体流式传输，不缓冲到内存，支持 GB 级大文件下载。
6. **Docker 认证**：自动处理 Docker Registry V2 的 Bearer Token 认证流程。
7. **法律合规**：请遵守当地法律法规和相关服务条款，仅供个人学习研究使用。

## 📜 许可证

[MIT License](LICENSE)
