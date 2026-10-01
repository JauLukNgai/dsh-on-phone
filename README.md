<h1 align="center">dsh-on-phone</h1>

<p align="center"><b>在手机上使用电脑里的 DeepSeek Harness。</b></p>

<p align="center">电脑和手机都装好 Tailscale、登录同一个账号，用手机浏览器打开电脑的地址即可。除了 Tailscale，两边不用再装任何东西 —— 没有专用 App、没有二维码、没有登录页。</p>

<p align="center">
  <a href="https://github.com/JauLukNgai/dsh-on-phone"><img src="https://img.shields.io/badge/github-JauLukNgai%2Fdsh--on--phone-181717?logo=github" alt="GitHub"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-0F172A" alt="Apache-2.0"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24-339933?logo=nodedotjs&logoColor=white" alt="Node"></a>
  <a href="#支持哪些-dsh-版本"><img src="https://img.shields.io/badge/DSH-0.1.0--rc.5%20…%200.2.0--rc.2-4B5563" alt="DSH"></a>
  <a href="#快速开始"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-0F172A" alt="Platform"></a>
</p>

<p align="center">
  <a href="#特性">特性</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#什么时候不适合用这个">不适合谁</a> ·
  <a href="#安全">安全</a> ·
  <a href="TROUBLESHOOTING.md">排障</a> ·
  <a href="CHANGELOG.md">更新记录</a> ·
  <a href="README.en.md">English</a>
</p>

<p align="center">
  <img src="assets/screenshots/left.PNG" width="26%" alt="手机上的会话与工作区抽屉">
  <img src="assets/screenshots/main.PNG" width="26%" alt="手机上的 DSH 首页与输入框">
  <img src="assets/screenshots/right.PNG" width="26%" alt="手机上的右侧工具面板">
</p>

## 特性

- **同一个 DSH，两个屏幕** — 会话列表、工作区、消息记录、你选的模型，两台设备上是同一份；一边发出的消息，另一边立刻可见。界面就是电脑上那个界面本身，只是按钮、抽屉和输入框被改成了适合手指的尺寸。
- **数据留在你自己的链路里** — 两台设备之间直连点对点，插件不设账号体系、不引入任何中转服务，也不上传任何内容。访问权由你自己的 Tailscale 私有网络决定。
- **电脑不限系统，手机不限机型** — 电脑端支持 macOS、Windows 与 Linux；手机端 iOS 与 Android 一致，只需要一个能打开网页的浏览器。
- **启用即用，手机端零配置** — 在 DSH 面板点一下启用，把地址复制到手机浏览器即可。不需要配对、不需要在手机上登录任何账号，也不需要在手机上安装第二个应用。

## 快速开始

### 1 · 让电脑和手机进入同一张 tailnet

这一步装的是 [Tailscale](https://tailscale.com/download) 官方的连网工具，和本插件不是一回事。

- **电脑** —— 装桌面版并登录。
- **手机** —— 从 App Store 或 [Google Play](https://play.google.com/store/apps/details?id=com.tailscale.ipn) 安装，用**同一个账号**登录，然后打开开关把连接连上：iOS 首次会弹「Tailscale 想要添加 VPN 配置」，要允许；Android 首次会请求允许建立 VPN 连接。手机上显示已连接，才算准备好。

  手机上如果配过自定义 DNS（NextDNS、AdGuard 这类），要把它改回「自动」，否则后面打不开插件的地址。改法见 [排障手册](TROUBLESHOOTING.md#4-远程通道显示-ready-但不可达)。

两台设备都连上后，设备列表里应该能互相看到。用不同账号的话，在 [Machines](https://login.tailscale.com/admin/machines) 里把电脑节点 Share 给对方。

### 2 · 打开 tailnet 上的两个开关

管理后台的 [DNS 页面](https://login.tailscale.com/admin/dns)，两个都要开：

| 开关 | 不开会怎样 |
| --- | --- |
| **MagicDNS** | 手机解析不了电脑的地址，页面打不开。 |
| **HTTPS Certificates** | 拿不到 HTTPS 证书，**启用远程访问会失败**。失败时面板只给一句笼统提示，不会告诉你是这项没开 —— 遇到莫名其妙的启用失败，先回来看它。 |

### 3 · 在电脑上安装插件

两种装法，选一种：

**1. npm 安装**（发布后可用）

```bash
dsh plugin --profile web add dsh-on-phone@latest
```

Desktop 用不上命令，在 **添加插件** 里填包名 `dsh-on-phone` 即可。

**2. 源码安装**（暂未发布时用；需要 Node `^22.19.0 || >=24.0.0`）

```bash
git clone https://github.com/JauLukNgai/dsh-on-phone.git && cd dsh-on-phone
npm ci && npm run build && npm pack
```

最后一条命令会打印出 `dsh-on-phone-<版本>.tgz` 的完整路径。

不管你选哪种，接着按你用的是哪个 DSH 走：

**DSH Desktop** —— 侧栏打开 **插件** → **添加插件**：npm 安装填包名 `dsh-on-phone`，源码安装填上面那个 tgz 的完整路径。点 **安装**，装完点 **立即启用**。Desktop 的插件由它自己管，命令行装不了 —— `dsh plugin --profile desktop` 会被直接拒绝。

**DSH CLI** —— npm 安装用第一条命令；源码安装就先 `cd dsh-on-phone`，然后：

```bash
dsh plugin --profile web add "$PWD/$(ls -1 dsh-on-phone-*.tgz | sort -V | tail -1)"
```

`web` 是 `dsh web` 用的 profile；你如果跑的是别的 profile，把名字换掉。

<details>
<summary>想换新版本？</summary>

插件不会自动更新，得先卸再装：Desktop 在插件面板里打开 **dsh-on-phone**、点 **卸载**，再按上面选的那种装法装一次（npm 装法填包名，源码装法添新版本的 tgz）；CLI 用 `dsh plugin --profile web remove dsh-on-phone` 再 `add`。

同一个版本重复安装会被跳过，卸载后再装一次即可。

装完如果面板里没出现，**完全退出再打开** DSH —— 插件运行在宿主里，不能热替换。
</details>

### 4 · 在电脑上启用远程访问

在 DSH 左下角打开 **移动访问** 面板，点 **启用远程访问**。面板上会出现一个专属网址（一串以 `.ts.net` 结尾的地址）—— 点 **复制地址** 把它发到手机上。

### 5 · 在手机上打开

用手机浏览器打开那个地址，就是你电脑上这个 DSH。

电脑上的 DSH 要一直开着：手机连的是电脑上正在运行的那个它。以后每次用，手机上保持 Tailscale 已连接即可。

面板上的 **诊断** 会跑一遍自检并给出可复制的报告，**重新连接** 用于连接出问题时重来一次。这两个按钮只在电脑上能用，手机上碰不到。

## 什么时候不适合用这个

- **手机装不了 Tailscale** —— 手机和电脑必须在同一张 tailnet 里。
- **要的是随时随地公网访问** —— 它走的是私有网络，不是公网隧道；`Funnel` 和端口转发都被明确禁止 —— 那会让访问控制失效。
- **想让别人用手机访问你的电脑** —— 能打开地址的设备被视为完全可信的操作者，可以读配置、跑工具；所以它只适合你自己的设备。
- **无法常开电脑** —— 手机连的是电脑上正在运行的那个 DSH。
- **用 DSH Web 的会话分享把链接发给别人** —— 那个链接在手机上也打得开，但这条通道只服务你 tailnet 里的设备。

## 安全

- **只有你 tailnet 里的设备能访问。** 请只把可信设备加入 tailnet。
- **不要开 Tailscale Funnel**，也不要用端口转发把它暴露到公网 —— 那会让访问控制失效。不用时关掉面板上的开关。
- 已知限制：DSH 自身的页面安全策略允许内联脚本。这个风险不由本插件引入，也无法在这一层消除。

完整威胁模型见 [SECURITY.md](SECURITY.md)。

## 排障

完整的排障手册在 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。最常见的三种：

- **手机打不开地址** — 确认手机 Tailscale 在运行、和电脑同一账号，且打开的是面板上那个地址（不是 `localhost`）；再回[快速开始](#快速开始)第 2 步检查那两个开关。Tailscale 明明连着、用 IP 也通，只有域名打不开的话，是手机上的 DNS 设置，见手册 [§4](TROUBLESHOOTING.md#4-远程通道显示-ready-但不可达)。
- **面板显示就绪但地址打不开** — 先点 **重新连接**；若提示端口被占用，说明电脑上 443 已被别的服务（例如你自己配的另一个 `tailscale serve`）占着，见手册 [§4](TROUBLESHOOTING.md#4-远程通道显示-ready-但不可达)。
- **页面排版乱了** — 地址后临时加 `?frontend=stock` 可加载 DSH 原生页面，用来判断问题出在哪一层。

## 支持哪些 DSH 版本

已验证 `0.1.0-rc.5` 到 `0.2.0-rc.2` 这一段的预发布版本，完整清单见 [package.json](package.json) 的 peerDependencies。安装成功却「没有任何反应」，通常就是撞上了版本门禁，见[排障](#排障)。

## 参与贡献

欢迎 [Issue](https://github.com/JauLukNgai/dsh-on-phone/issues) 与 PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 卸载

Desktop 用户在插件面板里打开 **dsh-on-phone** 点 **卸载**；命令行用户：

```bash
dsh plugin --profile web remove dsh-on-phone              # 只卸载插件
dsh plugin --profile web exec dsh-on-phone purge --yes    # 连同 $DSH_HOME/mobile-access/ 一起清理
```

`purge` 会把 `$DSH_HOME/mobile-access/` 整个删掉（配置、自定义 CSS/JS、扩展都在里面）。Desktop 上卸载后想一并清干净，手动删掉这个目录即可。

## 许可与致谢

Apache-2.0，详见 [LICENSE](LICENSE)。项目最初 fork 自 [dsh-mobile](https://github.com/saya-ch/dsh-mobile)，此后宿主与客户端实现已重写；远程通道建立在 [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve) 之上。
