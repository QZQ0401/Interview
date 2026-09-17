# 秋招 Tracker V2

这是一个可直接部署到 **GitHub Pages** 的纯前端秋招管理工具。

## V2 功能

- 投递新增 / 编辑 / 删除
- 公司优先级：高 / 中 / 低
- 招聘流程 Timeline
- 面试问题与单轮复盘
- 数据分析 Dashboard
- 状态分布、招聘漏斗、投递趋势、渠道转化
- 日历提醒
- 浏览器通知（网页打开时检查）
- `.ics` 日历导出
- 面试题库 / 答案 / 复盘 / 标签
- Timeline 面试问题一键沉淀到题库
- JSON 全量备份 / 恢复
- 投递 CSV 导出
- V1 LocalStorage 自动迁移
- Supabase 登录与跨设备云同步

---

## 1. 文件结构

```text
autumn-recruitment-tracker-v2/
├── index.html
├── styles.css
├── app.js
├── supabase.sql
└── README.md
```

## 2. 部署到 GitHub Pages

在 GitHub 新建仓库，例如：

```text
autumn-recruitment-tracker
```

把上面 5 个文件上传到仓库根目录，然后进入：

```text
Settings
→ Pages
→ Build and deployment
→ Source: Deploy from a branch
→ Branch: main
→ Folder: / (root)
→ Save
```

部署后地址一般是：

```text
https://你的用户名.github.io/autumn-recruitment-tracker/
```

---

# 3. 为什么 GitHub Pages 本身不能跨电脑保存数据

GitHub Pages 只负责托管静态网页，不能保存每个用户实时修改的数据。

V2 的架构是：

```text
GitHub Pages
  └─ 网页代码

浏览器 LocalStorage
  └─ 本机即时保存

Supabase Auth
  └─ 邮箱 / 密码登录

Supabase Postgres
  └─ 云端同步 Tracker 数据
```

所以可以做到：

```text
电脑 A 修改
→ 自动上传 Supabase
→ 电脑 B 打开同一个网页
→ 登录同一个账号
→ 智能同步
→ 看到同一份数据
```

---

# 4. 配置 Supabase 云同步

## 第一步：创建 Supabase 项目

在 Supabase 创建一个项目。

## 第二步：执行 SQL

打开 Supabase 的：

```text
SQL Editor
```

把项目中的：

```text
supabase.sql
```

完整复制并执行。

它会建立：

```text
public.user_data
```

并开启 RLS。每个登录用户只能访问自己的那一行数据。

## 第三步：获取网页配置

在 Supabase 项目设置/API 页面找到：

```text
Project URL
anon key / publishable key
```

网页中只能填写：

```text
anon key
或
publishable key
```

**不要填写 `service_role` key。**

## 第四步：在 Tracker 里配置

部署后的 Tracker 中点击：

```text
云同步
```

填写 Project URL 与 anon / publishable key，然后点击：

```text
保存并初始化
```

注册或登录账号即可。

---

# 5. 新电脑怎么使用

在另一台电脑：

1. 打开你的 GitHub Pages 地址。
2. 点击「云同步」。
3. 填写同一个 Supabase Project URL 和 anon / publishable key。
4. 登录同一个邮箱账号。
5. 点击「智能同步」。

如果新电脑本地完全为空、云端已有数据，V2 会**优先拉取云端**，不会用刚创建的空 LocalStorage 覆盖云端。

---

# 6. 同步策略

V2 使用：

```text
LocalStorage 本地优先
+
更新时间比较
+
Last Write Wins
```

本地发生修改后：

```text
立即保存 LocalStorage
→ 已登录时约 1 秒后自动上传 Supabase
```

登录时会比较本地和云端：

- 新设备本地为空、云端有数据 → 拉云端
- 本地有数据、云端为空 → 上传本地
- 两边都有数据 → `meta.updatedAt` 较新的覆盖较旧的

云同步窗口还有：

```text
智能同步
本地 → 云端
云端 → 本地
```

后两项属于强制覆盖，执行前会确认。

> 这套机制适合个人 Tracker。不要同时在两台设备上高频编辑同一份数据，否则最后保存的一方会覆盖较旧版本。

---

# 7. V1 数据迁移

如果浏览器中还存在第一版：

```text
autumn_recruitment_tracker_v1
```

V2 第一次打开时会自动迁移到：

```text
autumn_recruitment_tracker_v2
```

V1 原数据不会主动删除。

---

# 8. 日历提醒

日历支持：

- 面试时间
- 笔试截止
- HR 沟通
- Offer 截止
- 自定义事项
- 关联具体投递
- 完成状态
- 浏览器通知
- `.ics` 导出到 Apple Calendar / Google Calendar / Outlook 等

浏览器通知有一个限制：

**静态 GitHub Pages 在网页完全关闭时无法可靠执行后台定时提醒。**

当前版本会在网页打开时检查今日/逾期事项。

如果以后需要网页关闭也能提醒，可以在 V3 接入：

- Web Push
- Supabase Edge Functions
- 邮件通知
- Telegram / 飞书 / Slack Bot

---

# 9. 数据安全建议

即使已经使用云同步，也建议偶尔：

```text
备份 → 导出 JSON
```

这样同时有：

- LocalStorage
- Supabase
- JSON 离线备份

三份副本。

---

# 10. 本地运行

直接双击 `index.html` 可以使用本地功能。

由于浏览器可能限制 `file://` 页面加载第三方 ESM 模块，Supabase 云同步建议在 **GitHub Pages HTTPS 地址**上使用。

---

# 11. 可以继续做的 V3

- PWA：安装到手机桌面
- 网页关闭后的 Push Reminder
- Kanban 投递看板
- 多 Offer 薪资包对比
- 公司评分维度
- JD 关键词分析
- AI 模拟面试
- 自动生成周报与秋招总结
