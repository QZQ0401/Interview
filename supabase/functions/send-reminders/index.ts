import { withSupabase } from "npm:@supabase/server";

/* ============================================================
 * 秋招 Tracker V3 - 定时邮件提醒
 *
 * 调用方：
 * Supabase Cron，每 5 分钟调用一次。
 *
 * 安全：
 * - 此函数只接受名为 automations 的 Supabase Secret API key。
 * - 前端绝不能出现这个 Secret key。
 * - RESEND_API_KEY 只放在 Edge Function Secrets 中。
 * ============================================================ */

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const REMINDER_FROM_EMAIL =
  Deno.env.get("REMINDER_FROM_EMAIL") || "Interview Tracker <onboarding@resend.dev>";
const APP_PUBLIC_URL =
  Deno.env.get("APP_PUBLIC_URL") || "https://qzq0401.github.io/Interview/";

// Cron 偶尔失败时允许补发，但截止时间超过 24 小时后不再发送旧提醒。
const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

// 失败后至少间隔 10 分钟再重试同一个提醒。
const FAILED_RETRY_MS = 10 * 60 * 1000;

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function leadText(minutes: number) {
  if (minutes === 0) return "截止时间到达时";
  if (minutes < 60) return `提前 ${minutes} 分钟`;
  if (minutes < 1440) return `提前 ${minutes / 60} 小时`;
  return `提前 ${minutes / 1440} 天`;
}

async function sendEmail(to: string, subject: string, html: string) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: REMINDER_FROM_EMAIL,
      to: [to],
      subject,
      html
    })
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload?.message || `Resend HTTP ${response.status}`);
  }

  return payload;
}

export default {
  fetch: withSupabase(
    { auth: "secret:automations" },
    async (_request, ctx) => {
      if (!RESEND_API_KEY) {
        return Response.json(
          { ok: false, error: "RESEND_API_KEY 未配置" },
          { status: 500 }
        );
      }

      const admin = ctx.supabaseAdmin;
      const nowMs = Date.now();

      const { data: rows, error: rowError } = await admin
        .from("user_data")
        .select("user_id, data");

      if (rowError) {
        return Response.json(
          { ok: false, error: rowError.message },
          { status: 500 }
        );
      }

      let scanned = 0;
      let due = 0;
      let sent = 0;
      let skipped = 0;
      let failed = 0;

      for (const row of rows || []) {
        const reminders = Array.isArray(row.data?.reminders)
          ? row.data.reminders
          : [];

        for (const reminder of reminders) {
          scanned += 1;

          if (
            !reminder?.emailEnabled ||
            reminder?.done ||
            !reminder?.emailNotifyAt ||
            !reminder?.deadlineAt
          ) {
            continue;
          }

          const notifyMs = new Date(reminder.emailNotifyAt).getTime();
          const deadlineMs = new Date(reminder.deadlineAt).getTime();

          if (
            Number.isNaN(notifyMs) ||
            Number.isNaN(deadlineMs) ||
            nowMs < notifyMs ||
            nowMs > deadlineMs + RECOVERY_WINDOW_MS
          ) {
            continue;
          }

          due += 1;

          const notifyAtIso = new Date(notifyMs).toISOString();

          const { data: existingLog } = await admin
            .from("email_reminder_log")
            .select("id, status, attempted_at")
            .eq("user_id", row.user_id)
            .eq("reminder_id", reminder.id)
            .eq("notify_at", notifyAtIso)
            .maybeSingle();

          if (existingLog?.status === "sent") {
            skipped += 1;
            continue;
          }

          if (
            existingLog?.status === "failed" &&
            existingLog?.attempted_at &&
            nowMs - new Date(existingLog.attempted_at).getTime() < FAILED_RETRY_MS
          ) {
            skipped += 1;
            continue;
          }

          try {
            const { data: userResult, error: userError } =
              await admin.auth.admin.getUserById(row.user_id);

            if (userError) throw userError;

            const recipient = userResult?.user?.email;

            if (!recipient) {
              throw new Error("当前 Supabase 用户没有可用邮箱");
            }

            const application = Array.isArray(row.data?.applications)
              ? row.data.applications.find(
                  (item: Record<string, unknown>) =>
                    item?.id === reminder.applicationId
                )
              : null;

            const companyText = application
              ? `${application.company || ""} · ${application.role || ""}`
              : "";

            const subject = `⏰ 秋招提醒：${reminder.title}`;

            const html = `
              <div style="font-family:Arial,'PingFang SC','Microsoft YaHei',sans-serif;max-width:620px;margin:auto;color:#1d2520">
                <div style="padding:22px;border:1px solid #e4e8e5;border-radius:16px">
                  <div style="font-size:12px;color:#2f6f4e;font-weight:700">秋招 Tracker</div>
                  <h2 style="margin:8px 0 16px;font-size:22px">${escapeHtml(reminder.title)}</h2>

                  ${companyText ? `<p><strong>关联投递：</strong>${escapeHtml(companyText)}</p>` : ""}
                  <p><strong>截止时间：</strong>${escapeHtml(reminder.date)} ${escapeHtml(reminder.time)}</p>
                  <p><strong>提醒规则：</strong>${escapeHtml(leadText(Number(reminder.emailLeadMinutes || 0)))}</p>
                  ${reminder.timezone ? `<p><strong>时区：</strong>${escapeHtml(reminder.timezone)}</p>` : ""}
                  ${reminder.note ? `<p><strong>备注：</strong><br>${escapeHtml(reminder.note).replaceAll("\n", "<br>")}</p>` : ""}

                  <div style="margin-top:22px">
                    <a href="${escapeHtml(APP_PUBLIC_URL)}"
                       style="display:inline-block;padding:10px 16px;border-radius:10px;background:#2f6f4e;color:white;text-decoration:none">
                      打开秋招 Tracker
                    </a>
                  </div>
                </div>
                <p style="font-size:11px;color:#777;margin-top:12px">
                  这封邮件由你自己的秋招 Tracker 自动发送。
                </p>
              </div>
            `;

            const providerResult = await sendEmail(recipient, subject, html);

            const { error: logError } = await admin
              .from("email_reminder_log")
              .upsert(
                {
                  user_id: row.user_id,
                  reminder_id: reminder.id,
                  notify_at: notifyAtIso,
                  status: "sent",
                  provider_id: providerResult?.id || null,
                  attempted_at: new Date().toISOString(),
                  sent_at: new Date().toISOString(),
                  error: null
                },
                {
                  onConflict: "user_id,reminder_id,notify_at"
                }
              );

            if (logError) throw logError;

            sent += 1;
          } catch (error) {
            failed += 1;

            await admin
              .from("email_reminder_log")
              .upsert(
                {
                  user_id: row.user_id,
                  reminder_id: reminder.id,
                  notify_at: notifyAtIso,
                  status: "failed",
                  attempted_at: new Date().toISOString(),
                  error: error instanceof Error ? error.message : String(error)
                },
                {
                  onConflict: "user_id,reminder_id,notify_at"
                }
              );
          }
        }
      }

      return Response.json({
        ok: true,
        scanned,
        due,
        sent,
        skipped,
        failed,
        checkedAt: new Date().toISOString()
      });
    }
  )
};
