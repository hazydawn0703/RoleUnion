# RoleUnion

RoleUnion 将用户原始需求整理为有规划和代码依据的产品需求。用户通过项目链接与系统对话并确认诉求。系统对照有效规划判断方向，为符合规划的需求读取仓库实现，拆解为候选改动。产品经理处理待裁定需求、拆分或合并改动，并评审和导出 PRD。

## 本地启动

1. 安装 Node.js 22 或更高版本，运行 `npm ci`。
2. 自托管服务的运营者注册一次 GitHub App，本地回调 URL 为 `http://localhost:8787/apps/studio/api/auth/callback`。服务多个组织时允许 Any account 安装，只请求 Contents 和 Metadata 只读权限，关闭 Webhook。生成 App 私钥供服务端使用。
3. 将 `.env.example` 复制为 `.env`，填写 App ID、App URL 中的 slug、Client ID、Client secret 和私钥。可以将 PEM 放在一个双引号值里，换行写为字面量 `\n`。用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成会话密钥。
4. 配置支持 JSON object 响应的 OpenAI 兼容模型。所选服务会收到原始反馈和分析所需的规划或代码片段，请使用获准处理这些资料的服务。
5. 运行 `npm run dev` 后打开 `http://localhost:8787/apps/studio/`。部署运行命令为 `npm start`。分享链接时，将 `ROLEUNION_ORIGIN` 和 GitHub App 回调改为同一 HTTPS 域名，通过反向代理将 `/apps/studio/` 原样转发到服务。健康检查路径是 `/apps/studio/api/health`。

## 处理需求

1. 用 GitHub 登录，创建项目并录入产品规划。负责人可在「规划与仓库」按 GitHub 用户名邀请产品协作者或仓库管理员。受邀人登录后在「我的项目」接受邀请并切换项目。负责人可以撤销邀请或移除成员。
2. 分享项目的需求链接。用户补充场景和期望结果后确认提交。同一浏览器可以继续未完成的对话。
3. 系统立即判断规划符合度，证据不足时由产品经理裁定。待接入仓库的符合项会排队。负责人或受邀仓库管理员通过同一个只读 App 授权所管理的仓库，确认基准分支后开始代码分析。组织要求审批时，由组织所有者批准安装。此后可使用仓库内的规划文件。
4. 选择、合并或拆分候选改动，生成 PRD。草案中可以核对原话、规划引文和固定提交的代码证据。评审后的版本保留决策记录，采纳版本可下载为 Markdown。

## 验证与试用

私有部署可使用仓库专用的只读 Deploy key 接入其他账号的仓库。项目负责人或仓库管理员在「规划与仓库」输入仓库和基准分支，复制公钥给目标仓库的管理员。管理员在仓库 Settings → Deploy keys 中添加公钥，保持 Allow write access 未勾选。返回 Studio 验证固定提交后，可单独启用模型分析。撤销授权时在 GitHub 删除该公钥。服务端需要 Git 和 OpenSSH，私钥保存在持久数据目录的 repository-keys 下，服务使用 GitHub 公布的 Ed25519 主机公钥校验连接。

运行 `npm run check` 执行仓库边界检查和端到端集成测试。测试使用受控的 GitHub 和模型响应，覆盖对话确认、规划裁定、证据校验、拆并、草案评审和重启恢复。

真实项目试用时，选取此前处理过的一批需求，记录人工耗时和用 RoleUnion 处理时产品经理的实际投入。逐项复核自动拒绝的依据、误合并、重写范围，以及 PRD 中能否追溯到原话和代码。用同等评审质量下的投入时间判断是否适合切换日常流程。
