# RoleUnion

RoleUnion 将用户原始需求整理为有规划和代码依据的产品需求。用户通过项目链接与系统对话并确认诉求。系统对照有效规划判断方向，为符合规划的需求读取仓库实现，拆解为候选改动。产品经理处理待裁定需求、拆分或合并改动，并评审和导出 PRD。

## 本地启动

1. 安装 Node.js 22 或更高版本，运行 `npm ci`。
2. 注册 GitHub App，本地回调 URL 为 `http://localhost:8787/apps/studio/api/auth/callback`。在仓库权限中将 Contents 设为只读，关闭 Webhook。安装 App 时选择要接入的仓库。创建并下载 App 私钥。
3. 将 `.env.example` 复制为 `.env`，填写 App ID、App URL 中的 slug、Client ID、Client secret 和私钥。可以将 PEM 放在一个双引号值里，换行写为字面量 `\n`。用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成会话密钥。
4. 配置支持 JSON object 响应的 OpenAI 兼容模型。所选服务会收到原始反馈和分析所需的规划或代码片段，请使用获准处理这些资料的服务。
5. 运行 `npm run dev` 后打开 `http://localhost:8787/apps/studio/`。部署运行命令为 `npm start`。分享链接时，将 `ROLEUNION_ORIGIN` 和 GitHub App 回调改为同一 HTTPS 域名，通过反向代理将 `/apps/studio/` 原样转发到服务。健康检查路径是 `/apps/studio/api/health`。

## 处理需求

1. 用 GitHub 登录。选择已授权仓库及基准分支，指定一到五份规划材料。可以混合使用仓库内 UTF-8 Markdown、TXT 或 RST 文件，以及直接在项目内录入的规划。
2. 分享项目的需求链接。用户补充场景和期望结果后确认提交。同一浏览器可以继续未完成的对话。
3. 查看需求结果。明确符合规划的需求自动进入代码分析。明确冲突时，系统依据引文裁定。规划沉默、冲突或证据不足时，由产品经理确认方向。更新规划或代码后，可以重新处理受影响的需求。
4. 选择、合并或拆分候选改动，生成 PRD。草案中可以核对原话、规划引文和固定提交的代码证据。评审后的版本保留决策记录，采纳版本可下载为 Markdown。

## 验证与试用

运行 `npm run check` 执行仓库边界检查和端到端集成测试。测试使用受控的 GitHub 和模型响应，覆盖对话确认、规划裁定、证据校验、拆并、草案评审和重启恢复。

真实项目试用时，选取此前处理过的一批需求，记录人工耗时和用 RoleUnion 处理时产品经理的实际投入。逐项复核自动拒绝的依据、误合并、重写范围，以及 PRD 中能否追溯到原话和代码。用同等评审质量下的投入时间判断是否适合切换日常流程。
