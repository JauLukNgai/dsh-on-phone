/**
 * Instructions handed to the DSH agent when the user runs `/mobile <task>`.
 * The agent edits files under the DSH home; this text is what tells it the
 * layout of the mobile-access customization surface so it does not guess.
 */
export const MOBILE_CUSTOMIZATION_GUIDE = `你在为用户定制 DSH Mobile 的手机端。DSH Mobile 是一个把电脑上的 DeepSeek Harness 带到手机浏览器的插件，手机端界面和能力都来自本机文件。

所有改动只允许在 $DSH_HOME/mobile-access/ 目录内进行，绝不修改 DeepSeek Harness 的源码或其他目录。$DSH_HOME 是 DeepSeek Harness 的配置目录（通常为 ~/.dsh），先确认它的实际路径再操作。

手机端的能力分两层，按用户需求选择改动目标：

1. 界面与交互 —— 只改外观和交互，不需要碰电脑的文件或程序：
   - $DSH_HOME/mobile-access/mobile.css：手机端样式
   - $DSH_HOME/mobile-access/mobile.js：手机端脚本，用 window.dshMobile.register(({ root }) => { ... }) 把内容挂载到 root，返回清理函数
   - 保存后手机端几秒内自动应用，无需重启

2. 电脑端能力 —— 手机需要读电脑文件、执行命令或访问硬件时，创建扩展：
   - 目录：$DSH_HOME/mobile-access/extensions/<id>/，id 用小写字母数字和连字符（如 media-remote）
   - extension.json：{"schemaVersion":1,"id":"<id>","name":"显示名","version":"0.1.0","description":"说明"}
   - host.mjs：电脑端 Node.js 代码（可信本地代码，可读写文件、执行命令）。导出默认函数 (api) => { ... }，用 api.action('名称', { input, run }) 注册动作、api.route({ method, path, handle }) 注册路由、api.effect(fn) 注册清理
   - mobile.js：手机端脚本，用 window.dshMobile.define({ apiVersion:1, id:'<id>', activate(api) { ... } })，activate 返回清理函数
   - mobile.css：手机端样式（可选）
   - assets/：手机端静态资源（可选）
   - mobile.js 里用 api.host.invoke('动作名', 输入) 调 host.mjs 的 action，api.host.fetch('/路由路径') 调 route
   - 也可以先用命令生成模板：dsh plugin --profile web exec dsh-on-phone extension create <id> --name "<名称>"，再在模板上改

安全约束：
- host.mjs 拥有电脑用户的完整权限，绝不能放入不可信代码，也不要让手机端无条件执行任意命令
- 所有改动只限 $DSH_HOME/mobile-access/，不要动 DeepSeek Harness 源码

请执行用户需求：外观或交互类改 mobile.css / mobile.js；需要电脑能力的创建或修改扩展。完成后简要说明改了什么、手机端会有什么变化。`
