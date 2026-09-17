# 秋招 Tracker V3

V3 在 V2 基础上把“个人工具”进一步改成了接近完整 Web App 的使用体验。

## 新增功能

- 专门的登录页
- Supabase URL / Publishable key 不再要求每台电脑填写
- 登录后自动云同步
- 顶部实时同步状态
- 显示最后成功同步时间
- 同步失败横幅
- 指数退避自动重试
- 网络恢复自动同步
- 页面重新激活自动同步
- 每 60 秒自动检查云端
- 日历提醒
- 浏览器通知
- 邮件提醒提前时间：
  - 到点
  - 30 分钟
  - 1 小时
  - 3 小时
  - 1 天
  - 3 天
  - 7 天
- Supabase Cron 后台执行
- Supabase Edge Function
- Resend 邮件发送
- 邮件发送日志、防重复、失败重试
- V2 本地数据自动迁移

## 项目结构

```text
.
├── index.html
├── styles.css
├── app.js
├── config.js
├── supabase-v3.sql
├── SETUP_V3.md
├── README.md
├── .gitignore
└── supabase
    ├── config.toml
    └── functions
        └── send-reminders
            └── index.ts
```

## 首次升级

请按：

```text
SETUP_V3.md
```

操作。

最关键的是：

1. 在 `config.js` 填入 Supabase Project URL 与 **Publishable key**。
2. GitHub Pages 更新到 V3。
3. 在 Supabase 执行 `supabase-v3.sql`。
4. 配置 Resend。
5. 部署 `send-reminders` Edge Function。
6. 创建每 5 分钟运行的 Supabase Cron。

## 安全

`config.js` 中只能放：

```text
Supabase Project URL
Supabase Publishable key
```

它们属于浏览器客户端公开配置。

绝对不要提交：

```text
Supabase Secret API key
service_role key
Resend API key
```

这些只保存在 Supabase 后台。

## 正式网站

项目默认配置的 GitHub Pages 地址为：

```text
https://qzq0401.github.io/Interview/
```
