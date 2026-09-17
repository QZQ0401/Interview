# 秋招 Tracker V3：零基础配置步骤

你现在已经有可用的 Supabase 项目和 GitHub Pages。V3 主要新增：

1. 打开网页直接看到登录页，不再让每台电脑填写 Supabase URL/key。
2. 登录后自动同步。
3. 显示最后同步时间。
4. 同步失败有明显提示，并自动重试。
5. 基础日历 + 浏览器通知。
6. 通过 Supabase Cron + Edge Function + Resend，在网页关闭后仍可发邮件提醒。

---

# A. 先让 V3 前端上线

## 1. 修改 `config.js`

打开：

```text
config.js
```

把：

```js
SUPABASE_URL: "PASTE_YOUR_SUPABASE_PROJECT_URL_HERE",
SUPABASE_PUBLISHABLE_KEY: "PASTE_YOUR_SUPABASE_PUBLISHABLE_KEY_HERE",
```

替换成你已经测试成功的 Supabase：

```text
Project URL
Publishable key
```

示意：

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://xxxx.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_xxxxx",
  APP_URL: "https://qzq0401.github.io/Interview/"
};
```

注意：

```text
Publishable key      ✅ 可以放在 config.js 并提交 GitHub
旧版 anon key         ✅ 也可以
Secret key            ❌ 不能放
service_role key       ❌ 不能放
Resend API key         ❌ 不能放
```

## 2. 把 V3 文件覆盖到 GitHub

至少上传 / 覆盖：

```text
index.html
styles.css
app.js
config.js
supabase-v3.sql
README.md
SETUP_V3.md
```

以及保留 `supabase/` 文件夹作为后台函数源码备份。

GitHub Pages 会继续使用：

```text
https://qzq0401.github.io/Interview/
```

## 3. 测试前端

重新打开网页。

正常应该直接看到：

```text
秋招 Tracker V3
邮箱
密码
登录
```

登录成功后：

- 自动进入 Dashboard
- 自动拉取云端数据
- 顶部显示“云端已同步”
- 显示“上次同步 HH:mm:ss”

---

# B. 升级 Supabase 数据库

打开：

```text
Supabase Dashboard
→ SQL Editor
→ New query
```

把项目根目录中的：

```text
supabase-v3.sql
```

完整复制进去。

点击：

```text
Run
```

看到：

```text
Success
```

即可。

这一步会：

- 保留原来的 `user_data`
- 保留你已有的 Tracker 数据
- 新建 `email_reminder_log`
- 不会主动删除旧数据

---

# C. 配置 Resend 邮件服务

邮件提醒需要一个真正的邮件发送服务。

这里使用：

```text
Resend
```

## 1. 创建 Resend 账号

打开：

```text
https://resend.com
```

注册账号。

## 2. 创建 API Key

Resend Dashboard：

```text
API Keys
→ Create API Key
```

例如命名：

```text
interview-tracker
```

复制得到：

```text
re_xxxxxxxxx
```

这个值是服务器密钥：

```text
不要提交 GitHub
不要写进 config.js
```

## 3. 配置发件人

长期真实使用，建议在 Resend：

```text
Domains
→ Add Domain
```

绑定一个你拥有的域名。

验证完成后可以使用：

```text
Interview Tracker <reminders@你的域名.com>
```

如果你暂时只是验证 Edge Function 工作流程，可以先使用 Resend 提供的测试发件方式；但正式提醒建议使用已验证域名。

---

# D. 配置 Supabase Edge Function Secrets

打开：

```text
Supabase Dashboard
→ Edge Functions
→ Secrets
```

添加三个 Secret。

## `RESEND_API_KEY`

Value：

```text
re_xxxxxxxxx
```

## `REMINDER_FROM_EMAIL`

例如：

```text
Interview Tracker <reminders@你的域名.com>
```

## `APP_PUBLIC_URL`

Value：

```text
https://qzq0401.github.io/Interview/
```

Supabase 自己的 URL 和后台 Secret API key 不需要写进源码；托管的 Edge Function 环境会提供 Supabase 所需的环境变量。

---

# E. 创建专门给 Cron 用的 Supabase Secret API Key

这个 Key **绝对不能放到 GitHub**。

打开：

```text
Supabase Dashboard
→ Project Settings
→ API Keys
```

创建一个新的：

```text
Secret key
```

名称建议：

```text
automations
```

复制保存。

它大致类似：

```text
sb_secret_xxxxxxxxx
```

后面的 Edge Function 只接受名为：

```text
automations
```

的 Secret key。

---

# F. 部署 `send-reminders` Edge Function

## 最容易的方法：直接用 Supabase 网页编辑器

进入：

```text
Supabase Dashboard
→ Edge Functions
→ Deploy a new function
→ Via Editor
```

函数名称填写：

```text
send-reminders
```

删除默认代码。

打开本项目文件：

```text
supabase/functions/send-reminders/index.ts
```

全部复制进去。

点击：

```text
Deploy function
```

## 关闭平台 JWT 检查

这个函数不是普通用户调用，而是 Cron 用 Secret key 调用。

因此需要：

```text
verify_jwt = false
```

项目中已经包含：

```text
supabase/config.toml
```

如果你的 Supabase Dashboard 在函数设置中有：

```text
Verify JWT
```

请关闭。

如果网页编辑器里没有这个开关，可以使用 Supabase CLI 部署项目中的函数配置；但优先先看 Dashboard 的函数设置。

注意：关闭 `verify_jwt` 并不代表函数公开。函数内部仍然使用：

```text
auth: "secret:automations"
```

验证调用者必须持有你刚创建的 `automations` Secret API key。

---

# G. 手动测试 Edge Function

先在 Tracker 中创建一个提醒：

```text
标题：邮件测试
日期：今天
时间：未来几分钟
启用邮件提醒：勾选
提前多久：到点提醒
```

确认网页顶部显示：

```text
云端已同步
```

然后进入：

```text
Supabase
→ Edge Functions
→ send-reminders
→ Test
```

Method：

```text
POST
```

Header 添加：

```text
apikey: 你的 automations Secret key
```

发送。

如果提醒已经到发送时间，返回通常类似：

```json
{
  "ok": true,
  "scanned": 1,
  "due": 1,
  "sent": 1,
  "skipped": 0,
  "failed": 0
}
```

然后检查邮箱。

也可以检查：

```text
Table Editor
→ email_reminder_log
```

成功记录的：

```text
status = sent
```

---

# H. 创建 Supabase Cron

确认手动调用能发邮件之后，再做自动执行。

打开 Supabase：

```text
Integrations
→ Cron
```

某些 Dashboard 版本可能直接显示：

```text
Cron
或
Jobs
```

点击：

```text
Create job
```

Job Name：

```text
send-interview-reminders
```

Schedule：

```text
*/5 * * * *
```

意思是：

```text
每 5 分钟执行一次
```

选择：

```text
HTTP Request
```

Method：

```text
POST
```

URL：

```text
https://你的项目ref.supabase.co/functions/v1/send-reminders
```

Headers：

```text
apikey: 你的 automations Secret key
Content-Type: application/json
```

Body 可以填：

```json
{}
```

保存并启用。

从此以后：

```text
Supabase Cron
每 5 分钟
    ↓
send-reminders Edge Function
    ↓
读取所有用户的 Tracker 提醒
    ↓
判断邮件发送时间
    ↓
Resend
    ↓
你的登录邮箱
```

因此即使：

```text
GitHub Pages 没打开
电脑关机
浏览器退出
```

邮件仍可以从 Supabase 云端发送。

---

# I. V3 邮件提醒的防重复和自动恢复

后台有两层保护。

## 1. 防重复

每一次邮件发送会写入：

```text
email_reminder_log
```

唯一键：

```text
user_id + reminder_id + notify_at
```

已经 `sent` 的提醒不会再发一次。

## 2. 自动恢复

如果：

```text
Resend 暂时失败
Cron 某一轮失败
```

系统不会马上永久放弃。

失败记录至少等 10 分钟后允许再次尝试。

只要没有超过：

```text
截止时间 + 24 小时
```

后台仍允许补发。

---

# J. 前端自动同步恢复机制

V3 的前端也是“本地优先”。

修改数据：

```text
先写浏览器 LocalStorage
→ 再自动上传 Supabase
```

如果上传失败：

```text
顶部红色提示
→ 5 秒后自动重试
→ 10 秒
→ 20 秒
→ 40 秒
→ 最长 60 秒
```

此外：

```text
网络重新连接
重新切回网页
每 60 秒轮询
点击“立即重试”
```

都会再次尝试同步。

所以即使临时断网，也可以继续填写投递信息。

---

# K. 建议的最终测试

完成配置后，做下面 4 个测试：

### 测试 1：登录

无痕窗口打开：

```text
https://qzq0401.github.io/Interview/
```

应该只需要：

```text
邮箱 + 密码
```

不再需要填 Supabase URL/key。

### 测试 2：跨电脑

电脑 A 新增：

```text
测试公司 V3
```

等顶部：

```text
云端已同步
```

电脑 B 刷新 / 登录。

应该能看到。

### 测试 3：断网恢复

断开网络。

编辑一条投递。

页面应该：

```text
数据仍保留
顶部提示同步失败
```

恢复网络。

几秒后自动变回：

```text
云端已同步
```

### 测试 4：邮件

创建：

```text
未来 10 分钟的提醒
邮件提醒：到点
```

等 Cron 运行。

确认收到邮件。

---

# L. 两个非常重要的安全规则

可以公开：

```text
Supabase Project URL
Supabase Publishable key
```

不能公开：

```text
Supabase Secret API key
service_role key
Resend API key
```

后三者都只能保存在 Supabase 后台 Secrets / Cron 配置中。
