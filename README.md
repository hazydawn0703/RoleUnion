# RoleUnion

RoleUnion 是面向软件产品团队的 AI 需求工作台。用户通过项目链接与访谈助手「小鲸」交流，说明自己想完成什么、遇到了什么困难。产品经理在 Studio 中对照产品规划和现有代码判断哪些问题值得做、需要改哪里，再把选定的改动整理成可评审的产品需求文档（PRD）。

评审草案时，团队可以回看用户原话、支持需求的规划引文，以及固定提交中反映当前行为的代码行。产品经理据此决定改动范围、验收条件和是否采纳。[进入 RoleUnion Studio](https://roleunion.com/apps/studio/)

## 从第一次反馈到一份 PRD

1. **建立项目并分享需求链接。** 项目负责人用 GitHub 登录 Studio，创建项目并录入产品规划，点击「复制需求链接」发给用户。有了规划就可以开始访谈和判断需求方向，仓库可以稍后接入。
2. **让用户确认问题。** 用户打开链接即可与小鲸对话。例如，用户说「导出的订单金额对不上」，小鲸可以追问是哪张报表、在什么场景下对账、期望看到什么结果。小鲸整理出问题、场景和期望结果后，用户可以继续补充，也可以点击「确认并提交」。同一浏览器可继续此前的对话并查看处理状态。
3. **对照规划决定是否接纳。** 在「用户需求」中，产品经理可以查看用户原话、规划引文和判断理由。系统标出符合规划或有明确排除依据的需求，依据不足的交给产品经理裁定。已接纳的需求在仓库接入后进入代码分析。
4. **根据实现确定要改的部分。** 接入仓库后，系统读取基准分支上固定提交的相关文件，区分已有行为、需要修改的部分和待核实事项。产品经理在「候选改动」中核对文件与行号，可以把多个用户反馈涉及的同一项改动合并，也可以把一项需求拆开处理。
5. **评审并导出。** 在「候选改动」中勾选同一产品目标下的改动，生成包含当前行为、目标行为、范围和验收条件的草案。在「PRD 草案」中可核对证据、编辑版本、采纳、退回修改或拒绝。采纳的版本可导出为 Markdown。

## 协作与仓库接入

反馈用户通过项目专属链接参与访谈，无需 GitHub 登录。项目负责人可在「规划与仓库」按 GitHub 用户名邀请成员。**产品协作者**可以管理规划、查看代码证据和评审 PRD，**仓库管理员**负责连接仓库。受邀人登录 Studio 后，在「我的项目」接受邀请。

项目负责人或仓库管理员可以选择以下任一只读接入方式。连接后，项目也可以使用仓库中的规划文件。

- **GitHub App** — 选择已有安装授权的仓库，确认基准分支。组织要求审批时，由组织所有者批准安装。
- **仓库专用 Deploy key** — 在「规划与仓库」填写仓库和分支，将生成的公钥添加到目标仓库的 Deploy keys，保持只读权限。回到 Studio，点击「验证只读连接」，核对提交后点击「连接并启用代码分析」。删除 GitHub 上的公钥即可撤销读取。此方式需要服务端安装 Git 和 OpenSSH。

## 本地启动

准备 Node.js 22 或更高版本，在仓库根目录安装锁定的依赖。

```sh
npm ci
```

将 [.env.example](.env.example) 复制为 `.env`，完成以下配置。

| 配置 | 填写内容 |
| --- | --- |
| GitHub App | 每个服务实例配置一个 App，填写 App ID、slug、Client ID、Client secret 和私钥。回调地址设为 `http://localhost:8787/apps/studio/api/auth/callback`。使用 Contents 和 Metadata 只读权限，关闭 Webhook。服务多个组织时允许 Any account 安装。 |
| 会话密钥 | 将随机密钥写入 `ROLEUNION_SESSION_SECRET`。可用下方命令生成。 |
| 模型服务 | 设置 `ROLEUNION_LLM_BASE_URL`、`ROLEUNION_LLM_API_KEY` 和 `ROLEUNION_LLM_DEFAULT_MODEL`。服务需兼容 OpenAI 接口并支持 JSON object 响应。原始反馈、相关规划和分析所需的代码片段会发给该服务。 |

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

GitHub App 的 PEM 私钥可放在双引号中，用字面量 `\n` 表示换行。配置完成后运行 `npm run dev`，打开[本地 Studio](http://localhost:8787/apps/studio/)。

## 自托管与验证

生产环境使用 `npm start`。将 `ROLEUNION_ORIGIN` 设为对外的 HTTPS 源地址，使用同一源下的 `/apps/studio/api/auth/callback` 作为 GitHub App 回调，并通过反向代理原样转发 `/apps/studio/`。健康检查路径为 `/apps/studio/api/health`。

服务按单实例运行，项目、对话和评审记录保存在 `ROLEUNION_DATA_DIR`。为该目录配置持久存储和备份。使用 Deploy key 时，目录中的 `repository-keys` 还包含仓库访问私钥。

运行 `npm run check` 可执行开源边界检查和端到端集成测试。测试使用受控的 GitHub 和模型响应，覆盖需求确认、规划裁定、代码证据校验、候选改动拆并、草案评审和重启恢复。

试用时可选一批已评审的历史需求，比较产品经理从阅读原话到完成评审的实际用时，并复核拒绝理由、合并范围以及 PRD 引用的证据。

本仓库提供采用 Apache-2.0 许可的 Community Core，包含 Studio、服务端和文件存储实现。[架构说明](ARCHITECTURE.md) · [开源与部署边界](docs/repository-boundary.md) · [许可证](LICENSE)
