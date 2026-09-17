import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/* ========== 常量 ========== */

const STATUS_OPTIONS = [
  ["preparing", "准备投递"],
  ["applied", "已投递"],
  ["test", "笔试"],
  ["interview", "面试中"],
  ["hr", "HR 面"],
  ["offer", "Offer"],
  ["rejected", "已拒"],
  ["silent", "无回应"],
  ["withdrawn", "主动放弃"]
];

const PRIORITY_OPTIONS = [
  ["high", "高优先级"],
  ["medium", "中优先级"],
  ["low", "低优先级"]
];

const QUESTION_CATEGORIES = [
  "Java / JVM", "数据库", "计算机网络", "操作系统", "算法",
  "系统设计", "项目经历", "行为面 / HR", "其他"
];

const STATUS_MAP = Object.fromEntries(STATUS_OPTIONS);
const PRIORITY_MAP = Object.fromEntries(PRIORITY_OPTIONS);

const DONUT_COLORS = {
  preparing: "#9ca3af",
  applied: "#4f83e8",
  test: "#8b5cf6",
  interview: "#d6a232",
  hr: "#e8793b",
  offer: "#35a463",
  rejected: "#df5b59",
  silent: "#6b7280",
  withdrawn: "#9a6546"
};

const CONFIG = window.APP_CONFIG || {};
const APP_URL = CONFIG.APP_URL || window.location.origin + window.location.pathname;

let supabase = null;
let currentUser = null;
let data = createEmptyData();
let activeApplicationId = null;

let calendarCursor = new Date();
calendarCursor.setDate(1);

let cloudPushTimer = null;
let retryTimer = null;
let retryDelayMs = 5000;
let periodicSyncTimer = null;
let syncInFlight = false;

/* ========== DOM 快捷函数 ========== */

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

/* ========== 初始化 ========== */

init();

async function init() {
  fillStaticSelects();
  bindEvents();

  if (!isConfigReady()) {
    $("#configError").classList.remove("hidden");
    $("#authForm").querySelectorAll("input,button").forEach(el => el.disabled = true);
    $("#registerBtn").disabled = true;
    $("#forgotBtn").disabled = true;
    setAuthMessage("先完成 config.js 配置，再刷新网页。", "error");
    return;
  }

  supabase = createClient(
    CONFIG.SUPABASE_URL,
    CONFIG.SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    }
  );

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === "PASSWORD_RECOVERY" && session?.user) {
      const password = prompt("请输入新的登录密码（至少 6 位）：");
      if (password && password.length >= 6) {
        const { error } = await supabase.auth.updateUser({ password });
        alert(error ? `密码更新失败：${error.message}` : "密码已更新，请使用新密码登录。");
      }
    }

    if (session?.user) {
      await enterApp(session.user);
    } else {
      leaveApp();
    }
  });

  const { data: sessionData } = await supabase.auth.getSession();

  if (sessionData.session?.user) {
    await enterApp(sessionData.session.user);
  } else {
    leaveApp();
  }
}

function isConfigReady() {
  return Boolean(
    CONFIG.SUPABASE_URL &&
    CONFIG.SUPABASE_PUBLISHABLE_KEY &&
    !CONFIG.SUPABASE_URL.includes("PASTE_") &&
    !CONFIG.SUPABASE_PUBLISHABLE_KEY.includes("PASTE_")
  );
}

/* ========== 登录与账号 ========== */

async function enterApp(user) {
  const isSameUser = currentUser?.id === user.id;
  currentUser = user;

  $("#authScreen").classList.add("hidden");
  $("#app").classList.remove("hidden");

  $("#accountEmail").textContent = user.email || "当前账号";
  $("#accountBtn").textContent = (user.email || "Q").slice(0, 1).toUpperCase();

  if (!isSameUser) {
    data = loadLocalDataForUser(user.id);
    migrateV2ForUserIfNeeded(user.id);
    data = loadLocalDataForUser(user.id);
  }

  renderAll();
  updateLastSyncText();

  if (!isSameUser) {
    await smartSync({ silent: false });
  }

  startPeriodicSync();
  checkDueNotifications();
}

function leaveApp() {
  currentUser = null;
  $("#app").classList.add("hidden");
  $("#authScreen").classList.remove("hidden");
  $("#accountPopover").classList.add("hidden");
  stopPeriodicSync();
}

async function handleLogin(event) {
  event.preventDefault();

  if (!supabase) return;

  const email = $("#authEmail").value.trim();
  const password = $("#authPassword").value;

  setAuthMessage("正在登录…");

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    setAuthMessage(error.message, "error");
  } else {
    setAuthMessage("登录成功，正在同步数据…", "success");
  }
}

async function handleRegister() {
  if (!supabase) return;

  const email = $("#authEmail").value.trim();
  const password = $("#authPassword").value;

  if (!email || !password) {
    setAuthMessage("请先填写邮箱和密码。", "error");
    return;
  }

  setAuthMessage("正在创建账号…");

  const { data: result, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: APP_URL
    }
  });

  if (error) {
    setAuthMessage(error.message, "error");
    return;
  }

  if (result.session) {
    setAuthMessage("注册成功，正在进入 Tracker。", "success");
  } else {
    setAuthMessage("注册成功。请打开邮箱完成验证，然后回来登录。", "success");
  }
}

async function handleForgotPassword() {
  if (!supabase) return;

  const email = $("#authEmail").value.trim();

  if (!email) {
    setAuthMessage("请先填写邮箱。", "error");
    return;
  }

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: APP_URL
  });

  setAuthMessage(
    error ? error.message : "重置邮件已发送，请检查邮箱。",
    error ? "error" : "success"
  );
}

async function signOut() {
  await flushCloudPush();
  await supabase.auth.signOut();
  setAuthMessage("已退出登录。");
}

function setAuthMessage(message, type = "") {
  $("#authMessage").textContent = message;
  $("#authMessage").className = `auth-message ${type}`.trim();
}

/* ========== 数据模型与本地存储 ========== */

function createEmptyData() {
  const now = new Date().toISOString();

  return {
    version: 3,
    meta: {
      createdAt: now,
      updatedAt: now
    },
    applications: [],
    reminders: [],
    questions: []
  };
}

function localDataKey(userId) {
  return `autumn_recruitment_tracker_v3_${userId}`;
}

function lastSyncKey(userId) {
  return `autumn_recruitment_tracker_v3_lastsync_${userId}`;
}

function loadLocalDataForUser(userId) {
  try {
    const raw = localStorage.getItem(localDataKey(userId));
    return raw ? normalizeData(JSON.parse(raw)) : createEmptyData();
  } catch (error) {
    console.error("读取本地数据失败：", error);
    return createEmptyData();
  }
}

function migrateV2ForUserIfNeeded(userId) {
  const v3Key = localDataKey(userId);

  if (localStorage.getItem(v3Key)) return;

  try {
    const v2Raw = localStorage.getItem("autumn_recruitment_tracker_v2");
    if (!v2Raw) return;

    const migrated = normalizeData(JSON.parse(v2Raw));
    migrated.version = 3;
    migrated.meta.updatedAt = new Date().toISOString();
    localStorage.setItem(v3Key, JSON.stringify(migrated));
    showToast("已自动迁移 V2 本地数据");
  } catch (error) {
    console.warn("V2 数据迁移失败：", error);
  }
}

function normalizeData(input) {
  const empty = createEmptyData();
  const source = input && typeof input === "object" ? input : {};

  return {
    version: 3,
    meta: {
      createdAt: source.meta?.createdAt || empty.meta.createdAt,
      updatedAt: source.meta?.updatedAt || empty.meta.updatedAt
    },
    applications: Array.isArray(source.applications)
      ? source.applications.map(normalizeApplication)
      : [],
    reminders: Array.isArray(source.reminders)
      ? source.reminders.map(normalizeReminder)
      : [],
    questions: Array.isArray(source.questions)
      ? source.questions.map(normalizeQuestion)
      : []
  };
}

function normalizeApplication(item = {}) {
  const now = new Date().toISOString();

  return {
    id: item.id || createId("app"),
    company: item.company || "",
    role: item.role || "",
    roleType: item.roleType || "",
    applyDate: item.applyDate || "",
    channel: item.channel || "",
    location: item.location || "",
    salary: item.salary || "",
    priority: PRIORITY_MAP[item.priority] ? item.priority : "medium",
    status: STATUS_MAP[item.status] ? item.status : "applied",
    expectedResult: item.expectedResult || "",
    jobUrl: item.jobUrl || "",
    note: item.note || "",
    createdAt: item.createdAt || now,
    updatedAt: item.updatedAt || now,
    stages: Array.isArray(item.stages)
      ? item.stages.map(stage => ({
          id: stage.id || createId("stage"),
          name: stage.name || "",
          date: stage.date || "",
          result: stage.result || "",
          format: stage.format || "",
          interviewer: stage.interviewer || "",
          duration: stage.duration || "",
          questions: stage.questions || "",
          reflection: stage.reflection || "",
          notes: stage.notes || "",
          createdAt: stage.createdAt || now,
          updatedAt: stage.updatedAt || now
        }))
      : []
  };
}

function normalizeReminder(item = {}) {
  const now = new Date().toISOString();
  const date = item.date || "";
  const time = item.time || "09:00";
  const emailLeadMinutes = Number.isFinite(Number(item.emailLeadMinutes))
    ? Number(item.emailLeadMinutes)
    : 1440;

  const timing = computeReminderTiming(date, time, emailLeadMinutes);

  return {
    id: item.id || createId("rem"),
    title: item.title || "",
    date,
    time,
    applicationId: item.applicationId || "",
    note: item.note || "",
    done: Boolean(item.done),
    emailEnabled: Boolean(item.emailEnabled),
    emailLeadMinutes,
    timezone: item.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    deadlineAt: item.deadlineAt || timing.deadlineAt,
    emailNotifyAt: item.emailNotifyAt || timing.emailNotifyAt,
    createdAt: item.createdAt || now,
    updatedAt: item.updatedAt || now
  };
}

function normalizeQuestion(item = {}) {
  const now = new Date().toISOString();

  return {
    id: item.id || createId("q"),
    category: QUESTION_CATEGORIES.includes(item.category) ? item.category : "其他",
    difficulty: ["easy", "medium", "hard"].includes(item.difficulty)
      ? item.difficulty
      : "medium",
    companyApplicationId: item.companyApplicationId || "",
    stage: item.stage || "",
    text: item.text || "",
    answer: item.answer || "",
    reflection: item.reflection || "",
    tags: Array.isArray(item.tags) ? item.tags : [],
    createdAt: item.createdAt || now,
    updatedAt: item.updatedAt || now
  };
}

function saveData(options = {}) {
  if (!currentUser) return;

  data.meta.updatedAt = new Date().toISOString();
  localStorage.setItem(localDataKey(currentUser.id), JSON.stringify(data));

  renderAll();

  if (!options.skipCloud) {
    scheduleCloudPush();
  }
}

/* ========== 自动云同步 ========== */

function setSyncState(state, title) {
  const card = $("#syncCard");
  card.classList.remove("synced", "syncing", "error");

  if (state) card.classList.add(state);

  $("#syncStateText").textContent = title;
}

function recordSyncSuccess() {
  if (!currentUser) return;

  const now = new Date().toISOString();
  localStorage.setItem(lastSyncKey(currentUser.id), now);
  retryDelayMs = 5000;

  clearTimeout(retryTimer);
  retryTimer = null;

  $("#syncErrorBanner").classList.add("hidden");
  setSyncState("synced", "云端已同步");
  updateLastSyncText();
}

function updateLastSyncText() {
  if (!currentUser) return;

  const raw = localStorage.getItem(lastSyncKey(currentUser.id));

  if (!raw) {
    $("#lastSyncText").textContent = "尚未同步";
    return;
  }

  const date = new Date(raw);

  $("#lastSyncText").textContent =
    "上次同步 " +
    new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(date);
}

function handleSyncFailure(error) {
  console.error("云同步失败：", error);

  setSyncState("error", "同步失败");
  $("#syncErrorText").textContent =
    `${error?.message || "网络或云端暂时不可用"}。本地数据仍已保存，会自动重试。`;
  $("#syncErrorBanner").classList.remove("hidden");

  scheduleRetry();
}

function scheduleRetry() {
  if (!currentUser || retryTimer) return;

  const delay = retryDelayMs;
  retryDelayMs = Math.min(retryDelayMs * 2, 60000);

  retryTimer = setTimeout(async () => {
    retryTimer = null;
    await smartSync({ silent: true });
  }, delay);
}

function scheduleCloudPush() {
  if (!currentUser || !supabase) return;

  clearTimeout(cloudPushTimer);

  cloudPushTimer = setTimeout(async () => {
    cloudPushTimer = null;
    await pushCloudData();
  }, 800);
}

async function flushCloudPush() {
  if (!cloudPushTimer) return;

  clearTimeout(cloudPushTimer);
  cloudPushTimer = null;

  await pushCloudData();
}

async function fetchCloudRow() {
  const { data: row, error } = await supabase
    .from("user_data")
    .select("data, updated_at")
    .eq("user_id", currentUser.id)
    .maybeSingle();

  if (error) throw error;
  return row;
}

async function pushCloudData() {
  if (!currentUser || !supabase || syncInFlight) return;

  syncInFlight = true;
  setSyncState("syncing", "正在上传");

  try {
    const { error } = await supabase
      .from("user_data")
      .upsert(
        {
          user_id: currentUser.id,
          data: JSON.parse(JSON.stringify(data)),
          updated_at: new Date().toISOString()
        },
        { onConflict: "user_id" }
      );

    if (error) throw error;

    recordSyncSuccess();
  } catch (error) {
    handleSyncFailure(error);
  } finally {
    syncInFlight = false;
  }
}

async function smartSync({ silent = true } = {}) {
  if (!currentUser || !supabase || syncInFlight) return;

  syncInFlight = true;
  setSyncState("syncing", "正在同步");

  try {
    const row = await fetchCloudRow();

    if (!row?.data) {
      syncInFlight = false;
      await pushCloudData();
      if (!silent) showToast("已首次同步到云端");
      return;
    }

    const cloudData = normalizeData(row.data);

    const localCount =
      data.applications.length + data.reminders.length + data.questions.length;
    const cloudCount =
      cloudData.applications.length +
      cloudData.reminders.length +
      cloudData.questions.length;

    const localTime = new Date(data.meta.updatedAt || 0).getTime();
    const cloudTime = new Date(cloudData.meta.updatedAt || 0).getTime();

    if (!localCount && cloudCount) {
      data = cloudData;
      localStorage.setItem(localDataKey(currentUser.id), JSON.stringify(data));
      renderAll();
      if (!silent) showToast("已从云端恢复数据");
    } else if (localCount && !cloudCount) {
      syncInFlight = false;
      await pushCloudData();
      return;
    } else if (cloudTime > localTime) {
      data = cloudData;
      localStorage.setItem(localDataKey(currentUser.id), JSON.stringify(data));
      renderAll();
      if (!silent) showToast("已拉取较新的云端数据");
    } else if (localTime > cloudTime) {
      syncInFlight = false;
      await pushCloudData();
      return;
    }

    recordSyncSuccess();
  } catch (error) {
    handleSyncFailure(error);
  } finally {
    syncInFlight = false;
  }
}

async function forcePullCloud() {
  if (!confirm("确定用云端数据覆盖这台电脑的本地数据吗？")) return;

  try {
    setSyncState("syncing", "正在下载");
    const row = await fetchCloudRow();

    if (!row?.data) {
      alert("云端目前没有数据。");
      return;
    }

    data = normalizeData(row.data);
    localStorage.setItem(localDataKey(currentUser.id), JSON.stringify(data));
    renderAll();
    recordSyncSuccess();
    closeModal("backupModal");
    showToast("已强制拉取云端数据");
  } catch (error) {
    handleSyncFailure(error);
  }
}

function startPeriodicSync() {
  stopPeriodicSync();

  periodicSyncTimer = setInterval(() => {
    if (navigator.onLine && document.visibilityState === "visible") {
      smartSync({ silent: true });
    }
  }, 60000);
}

function stopPeriodicSync() {
  clearInterval(periodicSyncTimer);
  periodicSyncTimer = null;
}

/* ========== 通用工具 ========== */

function createId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "—";

  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDateTime(value) {
  if (!value) return "—";

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}

function toDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function todayKey() {
  return toDateKey(new Date());
}

function computeReminderTiming(date, time, leadMinutes) {
  if (!date || !time) {
    return { deadlineAt: "", emailNotifyAt: "" };
  }

  const localDeadline = new Date(`${date}T${time}:00`);

  if (Number.isNaN(localDeadline.getTime())) {
    return { deadlineAt: "", emailNotifyAt: "" };
  }

  const notify = new Date(localDeadline.getTime() - Number(leadMinutes || 0) * 60000);

  return {
    deadlineAt: localDeadline.toISOString(),
    emailNotifyAt: notify.toISOString()
  };
}

function getApplicationById(id) {
  return data.applications.find(item => item.id === id);
}

function getInitial(company) {
  return company ? company.trim().slice(0, 1).toUpperCase() : "?";
}

function sortByUpdatedAt(list) {
  return [...list].sort(
    (a, b) =>
      new Date(b.updatedAt || 0).getTime() -
      new Date(a.updatedAt || 0).getTime()
  );
}

function showToast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");

  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => $("#toast").classList.remove("show"), 1800);
}

function openModal(id) {
  document.getElementById(id).classList.add("show");
}

function closeModal(id) {
  document.getElementById(id).classList.remove("show");
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 100);
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

/* ========== 静态选项与事件 ========== */

function fillStaticSelects() {
  $("#status").innerHTML = STATUS_OPTIONS
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");

  $("#priority").innerHTML = PRIORITY_OPTIONS
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");

  $("#applicationStatusFilter").innerHTML =
    `<option value="">全部状态</option>` +
    STATUS_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");

  $("#applicationPriorityFilter").innerHTML =
    `<option value="">全部优先级</option>` +
    PRIORITY_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");

  $("#questionCategory").innerHTML =
    QUESTION_CATEGORIES.map(item => `<option>${escapeHtml(item)}</option>`).join("");

  $("#questionCategoryFilter").innerHTML =
    `<option value="">全部分类</option>` +
    QUESTION_CATEGORIES.map(item => `<option>${escapeHtml(item)}</option>`).join("");
}

function bindEvents() {
  $("#authForm").addEventListener("submit", handleLogin);
  $("#registerBtn").addEventListener("click", handleRegister);
  $("#forgotBtn").addEventListener("click", handleForgotPassword);

  $("#signOutBtn").addEventListener("click", signOut);
  $("#manualSyncBtn").addEventListener("click", () => smartSync({ silent: false }));
  $("#retrySyncBtn").addEventListener("click", () => smartSync({ silent: false }));

  $("#accountBtn").addEventListener("click", () => {
    $("#accountPopover").classList.toggle("hidden");
  });

  $("#tabs").addEventListener("click", event => {
    const button = event.target.closest("[data-view]");
    if (button) switchView(button.dataset.view);
  });

  $("#quickAddBtn").addEventListener("click", openAddApplicationModal);
  $("#addApplicationBtn").addEventListener("click", openAddApplicationModal);
  $("#saveApplicationBtn").addEventListener("click", saveApplicationFromForm);

  $("#applicationSearch").addEventListener("input", renderApplications);
  $("#applicationStatusFilter").addEventListener("change", renderApplications);
  $("#applicationPriorityFilter").addEventListener("change", renderApplications);
  $("#applicationLocationFilter").addEventListener("change", renderApplications);

  $("#saveStageBtn").addEventListener("click", saveStageFromForm);

  $("#addReminderBtn").addEventListener("click", () => openAddReminderModal());
  $("#saveReminderBtn").addEventListener("click", saveReminderFromForm);
  $("#prevMonthBtn").addEventListener("click", () => moveCalendarMonth(-1));
  $("#nextMonthBtn").addEventListener("click", () => moveCalendarMonth(1));
  $("#todayBtn").addEventListener("click", () => {
    calendarCursor = new Date();
    calendarCursor.setDate(1);
    renderCalendar();
  });
  $("#notifyBtn").addEventListener("click", requestNotificationPermission);
  $("#exportIcsBtn").addEventListener("click", exportIcs);

  $("#addQuestionBtn").addEventListener("click", openAddQuestionModal);
  $("#saveQuestionBtn").addEventListener("click", saveQuestionFromForm);
  $("#questionSearch").addEventListener("input", renderQuestions);
  $("#questionCategoryFilter").addEventListener("change", renderQuestions);
  $("#questionCompanyFilter").addEventListener("change", renderQuestions);

  $("#backupBtn").addEventListener("click", () => openModal("backupModal"));
  $("#exportJsonBtn").addEventListener("click", exportJson);
  $("#exportCsvBtn").addEventListener("click", exportCsv);
  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", importJson);
  $("#pullCloudBtn").addEventListener("click", forcePullCloud);

  $("#closeDrawer").addEventListener("click", closeDrawer);
  $("#drawerBackdrop").addEventListener("click", event => {
    if (event.target === $("#drawerBackdrop")) closeDrawer();
  });

  $$("[data-close]").forEach(button => {
    button.addEventListener("click", () => closeModal(button.dataset.close));
  });

  $$(".modal-backdrop").forEach(backdrop => {
    backdrop.addEventListener("click", event => {
      if (event.target === backdrop) backdrop.classList.remove("show");
    });
  });

  window.addEventListener("online", () => smartSync({ silent: true }));
  window.addEventListener("offline", () => {
    handleSyncFailure(new Error("当前设备已离线"));
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && currentUser && navigator.onLine) {
      smartSync({ silent: true });
      checkDueNotifications();
    }
  });

  window.addEventListener("beforeunload", () => {
    if (currentUser) {
      localStorage.setItem(localDataKey(currentUser.id), JSON.stringify(data));
    }
  });

  window.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      $$(".modal-backdrop.show").forEach(item => item.classList.remove("show"));
      $("#drawerBackdrop").classList.remove("show");
      $("#accountPopover").classList.add("hidden");
    }
  });
}

/* ========== 页面渲染 ========== */

function switchView(view) {
  $$(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === view));
  $$(".view").forEach(section =>
    section.classList.toggle("active", section.id === `view-${view}`)
  );

  if (view === "dashboard") renderDashboard();
  if (view === "applications") renderApplications();
  if (view === "calendar") renderCalendar();
  if (view === "questions") renderQuestions();
}

function renderAll() {
  if (!currentUser) return;

  renderDashboard();
  renderApplicationFilters();
  renderApplications();
  renderReminderApplicationOptions();
  renderCalendar();
  renderQuestionFilters();
  renderQuestions();
  refreshDrawerIfOpen();
}

function renderDashboard() {
  const total = data.applications.length;
  const active = data.applications.filter(item =>
    ["test", "interview", "hr"].includes(item.status)
  ).length;
  const offers = data.applications.filter(item => item.status === "offer").length;
  const high = data.applications.filter(item => item.priority === "high").length;
  const pending = data.reminders.filter(item => !item.done).length;
  const offerRate = total ? ((offers / total) * 100).toFixed(1) : "0.0";

  const cards = [
    ["总投递", total, "全部岗位"],
    ["进行中", active, "笔试 / 面试 / HR"],
    ["Offer", offers, "已拿到 Offer"],
    ["高优先级", high, "重点关注"],
    ["待办提醒", pending, "未完成事项"],
    ["Offer 率", `${offerRate}%`, "Offer / 总投递"]
  ];

  $("#dashboardStats").innerHTML = cards
    .map(item => `
      <article class="panel stat-card">
        <div class="stat-label">${item[0]}</div>
        <div class="stat-value">${item[1]}</div>
        <div class="stat-sub">${item[2]}</div>
      </article>`)
    .join("");

  renderStatusDonut();
  renderFunnel();
  renderPriorityChart();
  renderTrendChart();
  renderDashboardUpcoming();
}

function renderStatusDonut() {
  const total = data.applications.length;
  $("#donutTotal").textContent = total;

  const counts = STATUS_OPTIONS
    .map(([value, label]) => ({
      value,
      label,
      count: data.applications.filter(item => item.status === value).length
    }))
    .filter(item => item.count > 0);

  if (!total) {
    $("#statusDonut").style.background = "#e8ece9";
    $("#statusLegend").innerHTML = `<div class="muted" style="font-size:10px">暂无投递数据。</div>`;
    return;
  }

  let cursor = 0;
  const segments = counts.map(item => {
    const start = cursor;
    cursor += (item.count / total) * 100;
    return `${DONUT_COLORS[item.value]} ${start}% ${cursor}%`;
  });

  $("#statusDonut").style.background = `conic-gradient(${segments.join(",")})`;

  $("#statusLegend").innerHTML = counts.map(item => `
    <div class="legend-item">
      <div class="legend-name"><span class="legend-dot" style="background:${DONUT_COLORS[item.value]}"></span>${escapeHtml(item.label)}</div>
      <strong>${item.count}</strong>
    </div>`).join("");
}

function renderFunnel() {
  const total = data.applications.length || 1;

  const rows = [
    ["已投递", data.applications.filter(i => i.status !== "preparing").length],
    ["进入笔试", data.applications.filter(i => ["test","interview","hr","offer"].includes(i.status)).length],
    ["进入面试", data.applications.filter(i => ["interview","hr","offer"].includes(i.status)).length],
    ["进入 HR", data.applications.filter(i => ["hr","offer"].includes(i.status)).length],
    ["Offer", data.applications.filter(i => i.status === "offer").length]
  ];

  $("#funnelList").innerHTML = rows.map(([label, count]) => {
    const percent = data.applications.length
      ? Math.round((count / total) * 100)
      : 0;

    return `
      <div class="progress-row">
        <div class="progress-head"><span>${label}</span><span>${count} · ${percent}%</span></div>
        <div class="progress-track"><div class="progress-bar" style="width:${percent}%"></div></div>
      </div>`;
  }).join("");
}

function renderPriorityChart() {
  const rows = PRIORITY_OPTIONS.map(([value, label]) => ({
    label,
    count: data.applications.filter(item => item.priority === value).length
  }));

  const max = Math.max(...rows.map(i => i.count), 1);

  $("#priorityChart").innerHTML = rows.map(item => `
    <div class="bar-row">
      <span>${item.label}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(item.count / max) * 100}%"></div></div>
      <strong>${item.count}</strong>
    </div>`).join("");
}

function renderTrendChart() {
  const now = new Date();
  const months = [];

  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: `${d.getMonth() + 1}月`,
      count: 0
    });
  }

  data.applications.forEach(item => {
    const target = months.find(m => m.key === (item.applyDate || "").slice(0, 7));
    if (target) target.count++;
  });

  const max = Math.max(...months.map(m => m.count), 1);

  $("#trendChart").innerHTML = months.map(item => {
    const height = item.count ? Math.max((item.count / max) * 132, 8) : 3;

    return `
      <div class="trend-col">
        <div class="trend-bar-wrap"><div class="trend-bar" style="height:${height}px"></div></div>
        <div class="trend-count">${item.count}</div>
        <div class="trend-label">${item.label}</div>
      </div>`;
  }).join("");
}

function renderDashboardUpcoming() {
  const rows = getUpcomingReminders(7).slice(0, 5);

  $("#dashboardUpcoming").innerHTML = rows.length
    ? rows.map(item => `
      <button class="mini-item" onclick="editReminder('${item.id}')">
        <div class="mini-item-title">${escapeHtml(item.title)}</div>
        <div class="mini-item-meta">${escapeHtml(formatDate(item.date))} ${escapeHtml(item.time)}${item.emailEnabled ? " · ✉️ 邮件提醒" : ""}</div>
      </button>`).join("")
    : `<div class="muted" style="font-size:10px">未来 7 天没有待办。</div>`;
}

/* ========== 投递管理 ========== */

function renderApplicationFilters() {
  const current = $("#applicationLocationFilter").value;

  const locations = [...new Set(
    data.applications.map(i => (i.location || "").trim()).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, "zh-CN"));

  $("#applicationLocationFilter").innerHTML =
    `<option value="">全部地点</option>` +
    locations.map(item => `<option>${escapeHtml(item)}</option>`).join("");

  if (locations.includes(current)) $("#applicationLocationFilter").value = current;
}

function getFilteredApplications() {
  const keyword = $("#applicationSearch").value.trim().toLowerCase();
  const status = $("#applicationStatusFilter").value;
  const priority = $("#applicationPriorityFilter").value;
  const location = $("#applicationLocationFilter").value;
  const weight = { high: 3, medium: 2, low: 1 };

  return [...data.applications]
    .filter(item => {
      const text = [
        item.company, item.role, item.roleType, item.channel,
        item.location, item.note, item.expectedResult
      ].join(" ").toLowerCase();

      return (
        (!keyword || text.includes(keyword)) &&
        (!status || item.status === status) &&
        (!priority || item.priority === priority) &&
        (!location || item.location === location)
      );
    })
    .sort((a, b) => {
      const p = weight[b.priority] - weight[a.priority];
      return p || (new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    });
}

function renderApplications() {
  const rows = getFilteredApplications();

  if (!rows.length) {
    $("#applicationsTable").innerHTML = `
      <div class="empty-state">
        <div class="empty-emoji">📮</div>
        <div class="empty-title">${data.applications.length ? "没有符合条件的投递" : "还没有投递记录"}</div>
        <div>${data.applications.length ? "调整筛选条件试试看。" : "点击“新增投递”开始记录。"}</div>
      </div>`;
    return;
  }

  $("#applicationsTable").innerHTML = `
    <table>
      <thead><tr><th>公司 / 岗位</th><th>优先级</th><th>投递时间</th><th>状态</th><th>当前进度</th><th>地点</th><th>最近更新</th><th>操作</th></tr></thead>
      <tbody>
        ${rows.map(item => {
          const latestStage = [...item.stages]
            .sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];

          return `
            <tr>
              <td><div class="company-cell"><div class="company-avatar">${escapeHtml(getInitial(item.company))}</div><div><button class="link-button" onclick="openDrawer('${item.id}')">${escapeHtml(item.company)}</button><div class="company-meta">${escapeHtml(item.role)}</div></div></div></td>
              <td><span class="priority-badge priority-${item.priority}">${escapeHtml(PRIORITY_MAP[item.priority])}</span></td>
              <td>${escapeHtml(formatDate(item.applyDate))}</td>
              <td><span class="status-badge status-${item.status}"><span class="status-dot"></span>${escapeHtml(STATUS_MAP[item.status])}</span></td>
              <td>${escapeHtml(latestStage?.name || "—")}</td>
              <td>${escapeHtml(item.location || "—")}</td>
              <td>${escapeHtml(formatDateTime(item.updatedAt))}</td>
              <td><button class="btn btn-sm" onclick="editApplication('${item.id}')">编辑</button></td>
            </tr>`;
        }).join("")}
      </tbody>
    </table>`;
}

function openAddApplicationModal() {
  $("#applicationForm").reset();
  $("#applicationId").value = "";
  $("#status").value = "applied";
  $("#priority").value = "medium";
  $("#applyDate").value = todayKey();
  $("#applicationModalTitle").textContent = "新增投递";
  openModal("applicationModal");
}

function editApplication(id) {
  const item = getApplicationById(id);
  if (!item) return;

  $("#applicationId").value = item.id;
  $("#company").value = item.company;
  $("#role").value = item.role;
  $("#roleType").value = item.roleType;
  $("#applyDate").value = item.applyDate;
  $("#channel").value = item.channel;
  $("#location").value = item.location;
  $("#salary").value = item.salary;
  $("#priority").value = item.priority;
  $("#status").value = item.status;
  $("#expectedResult").value = item.expectedResult;
  $("#jobUrl").value = item.jobUrl;
  $("#note").value = item.note;
  $("#applicationModalTitle").textContent = "编辑投递";
  openModal("applicationModal");
}

function saveApplicationFromForm() {
  if (!$("#applicationForm").reportValidity()) return;

  const id = $("#applicationId").value;
  const now = new Date().toISOString();

  const payload = {
    company: $("#company").value.trim(),
    role: $("#role").value.trim(),
    roleType: $("#roleType").value.trim(),
    applyDate: $("#applyDate").value,
    channel: $("#channel").value,
    location: $("#location").value.trim(),
    salary: $("#salary").value.trim(),
    priority: $("#priority").value,
    status: $("#status").value,
    expectedResult: $("#expectedResult").value.trim(),
    jobUrl: $("#jobUrl").value.trim(),
    note: $("#note").value.trim()
  };

  if (id) {
    const index = data.applications.findIndex(i => i.id === id);
    if (index >= 0) {
      data.applications[index] = {
        ...data.applications[index],
        ...payload,
        updatedAt: now
      };
    }
  } else {
    data.applications.unshift({
      id: createId("app"),
      ...payload,
      stages: [],
      createdAt: now,
      updatedAt: now
    });
  }

  closeModal("applicationModal");
  saveData();
  showToast(id ? "投递已更新" : "投递已添加");
}

function deleteApplication(id) {
  const item = getApplicationById(id);

  if (!item || !confirm(`确定删除「${item.company} · ${item.role}」吗？`)) return;

  data.applications = data.applications.filter(i => i.id !== id);
  data.reminders = data.reminders.map(i =>
    i.applicationId === id ? { ...i, applicationId: "" } : i
  );
  data.questions = data.questions.map(i =>
    i.companyApplicationId === id ? { ...i, companyApplicationId: "" } : i
  );

  closeDrawer();
  saveData();
}

/* ========== 详情与流程 ========== */

function openDrawer(id) {
  const item = getApplicationById(id);
  if (!item) return;

  activeApplicationId = id;
  $("#drawerHeaderTitle").textContent = `${item.company} · ${item.role}`;
  $("#drawerBody").innerHTML = buildDrawerContent(item);
  $("#drawerBackdrop").classList.add("show");
}

function closeDrawer() {
  $("#drawerBackdrop").classList.remove("show");
  activeApplicationId = null;
}

function refreshDrawerIfOpen() {
  if (!$("#drawerBackdrop").classList.contains("show") || !activeApplicationId) return;

  const item = getApplicationById(activeApplicationId);

  if (!item) {
    closeDrawer();
    return;
  }

  $("#drawerHeaderTitle").textContent = `${item.company} · ${item.role}`;
  $("#drawerBody").innerHTML = buildDrawerContent(item);
}

function buildDrawerContent(item) {
  const stages = [...item.stages].sort((a, b) =>
    (a.date || "").localeCompare(b.date || "")
  );

  const timeline = stages.length
    ? stages.map(stage => `
      <div class="timeline-item">
        <div class="timeline-dot"></div>
        <div class="timeline-card">
          <div class="timeline-top">
            <div><div class="timeline-stage">${escapeHtml(stage.name)}</div><div class="company-meta">${escapeHtml(stage.result || "结果未填写")}${stage.format ? ` · ${escapeHtml(stage.format)}` : ""}</div></div>
            <div class="timeline-date">${escapeHtml(formatDate(stage.date))}</div>
          </div>
          ${stage.questions ? `<div class="timeline-section"><strong>面试问题</strong><p>${escapeHtml(stage.questions)}</p></div>` : ""}
          ${stage.reflection ? `<div class="timeline-section"><strong>复盘</strong><p>${escapeHtml(stage.reflection)}</p></div>` : ""}
          ${stage.notes ? `<div class="timeline-section"><strong>其他记录</strong><p>${escapeHtml(stage.notes)}</p></div>` : ""}
          <div class="timeline-actions">
            <button class="btn btn-sm" onclick="openEditStageModal('${item.id}','${stage.id}')">编辑</button>
            <button class="btn btn-sm" onclick="stageToQuestion('${item.id}','${stage.id}')">沉淀到题库</button>
            <button class="btn btn-sm btn-danger" onclick="deleteStage('${item.id}','${stage.id}')">删除</button>
          </div>
        </div>
      </div>`).join("")
    : `<div class="empty-state"><div class="empty-emoji">🧭</div><div class="empty-title">还没有流程记录</div></div>`;

  return `
    <section class="detail-hero">
      <div class="detail-title"><div class="company-avatar" style="width:42px;height:42px">${escapeHtml(getInitial(item.company))}</div><div><h2>${escapeHtml(item.company)}</h2><div class="detail-sub">${escapeHtml(item.role)}${item.roleType ? ` · ${escapeHtml(item.roleType)}` : ""}</div></div></div>
      <div class="button-row" style="margin-top:11px"><span class="status-badge status-${item.status}">${escapeHtml(STATUS_MAP[item.status])}</span><span class="priority-badge priority-${item.priority}">${escapeHtml(PRIORITY_MAP[item.priority])}</span></div>
      <div class="detail-grid">
        <div class="detail-kv"><div class="detail-kv-label">投递时间</div><div class="detail-kv-value">${escapeHtml(formatDate(item.applyDate))}</div></div>
        <div class="detail-kv"><div class="detail-kv-label">投递渠道</div><div class="detail-kv-value">${escapeHtml(item.channel || "—")}</div></div>
        <div class="detail-kv"><div class="detail-kv-label">工作地点</div><div class="detail-kv-value">${escapeHtml(item.location || "—")}</div></div>
        <div class="detail-kv"><div class="detail-kv-label">薪资</div><div class="detail-kv-value">${escapeHtml(item.salary || "—")}</div></div>
        <div class="detail-kv"><div class="detail-kv-label">最终结果</div><div class="detail-kv-value">${escapeHtml(item.expectedResult || "—")}</div></div>
        <div class="detail-kv"><div class="detail-kv-label">最近更新</div><div class="detail-kv-value">${escapeHtml(formatDateTime(item.updatedAt))}</div></div>
      </div>
      ${item.note ? `<div class="detail-kv" style="margin-top:8px"><div class="detail-kv-label">备注</div><div class="detail-kv-value" style="white-space:pre-wrap">${escapeHtml(item.note)}</div></div>` : ""}
      <div class="button-row" style="margin-top:10px">
        <button class="btn btn-sm" onclick="editApplication('${item.id}')">编辑投递</button>
        <button class="btn btn-sm" onclick="openAddReminderModal('${item.id}')">添加提醒</button>
        <button class="btn btn-sm btn-danger" onclick="deleteApplication('${item.id}')">删除投递</button>
      </div>
    </section>

    <div class="timeline-head"><h3 class="section-title" style="margin:0">招聘流程 Timeline</h3><button class="btn btn-sm btn-primary" onclick="openAddStageModal('${item.id}')">＋ 新增流程</button></div>
    <div class="timeline">${timeline}</div>`;
}

function openAddStageModal(applicationId) {
  $("#stageForm").reset();
  $("#stageApplicationId").value = applicationId;
  $("#stageId").value = "";
  $("#stageDate").value = todayKey();
  $("#stageModalTitle").textContent = "新增流程";
  openModal("stageModal");
}

function openEditStageModal(applicationId, stageId) {
  const app = getApplicationById(applicationId);
  const stage = app?.stages.find(i => i.id === stageId);
  if (!stage) return;

  $("#stageApplicationId").value = applicationId;
  $("#stageId").value = stage.id;
  $("#stageName").value = stage.name;
  $("#stageDate").value = stage.date;
  $("#stageResult").value = stage.result;
  $("#stageFormat").value = stage.format;
  $("#stageInterviewer").value = stage.interviewer;
  $("#stageDuration").value = stage.duration;
  $("#stageQuestions").value = stage.questions;
  $("#stageReflection").value = stage.reflection;
  $("#stageNotes").value = stage.notes;
  $("#stageModalTitle").textContent = "编辑流程";
  openModal("stageModal");
}

function saveStageFromForm() {
  if (!$("#stageForm").reportValidity()) return;

  const applicationId = $("#stageApplicationId").value;
  const stageId = $("#stageId").value;
  const app = getApplicationById(applicationId);
  if (!app) return;

  const now = new Date().toISOString();
  const payload = {
    name: $("#stageName").value.trim(),
    date: $("#stageDate").value,
    result: $("#stageResult").value.trim(),
    format: $("#stageFormat").value.trim(),
    interviewer: $("#stageInterviewer").value.trim(),
    duration: $("#stageDuration").value.trim(),
    questions: $("#stageQuestions").value.trim(),
    reflection: $("#stageReflection").value.trim(),
    notes: $("#stageNotes").value.trim()
  };

  if (stageId) {
    const index = app.stages.findIndex(i => i.id === stageId);
    if (index >= 0) {
      app.stages[index] = { ...app.stages[index], ...payload, updatedAt: now };
    }
  } else {
    app.stages.push({
      id: createId("stage"),
      ...payload,
      createdAt: now,
      updatedAt: now
    });
  }

  app.updatedAt = now;
  closeModal("stageModal");
  saveData();
}

function deleteStage(applicationId, stageId) {
  const app = getApplicationById(applicationId);
  if (!app || !confirm("确定删除这个流程节点吗？")) return;

  app.stages = app.stages.filter(i => i.id !== stageId);
  app.updatedAt = new Date().toISOString();
  saveData();
}

function stageToQuestion(applicationId, stageId) {
  const app = getApplicationById(applicationId);
  const stage = app?.stages.find(i => i.id === stageId);
  if (!app || !stage) return;

  openAddQuestionModal();
  $("#questionCompany").value = applicationId;
  $("#questionStage").value = stage.name;
  $("#questionText").value = stage.questions || `${app.company} ${stage.name}面试问题`;
  $("#questionReflection").value = stage.reflection;
}

/* ========== 日历与邮件提醒 ========== */

function renderReminderApplicationOptions() {
  const current = $("#reminderApplication").value;

  $("#reminderApplication").innerHTML =
    `<option value="">不关联投递</option>` +
    data.applications
      .slice()
      .sort((a, b) => a.company.localeCompare(b.company, "zh-CN"))
      .map(item => `<option value="${item.id}">${escapeHtml(item.company)} · ${escapeHtml(item.role)}</option>`)
      .join("");

  if (data.applications.some(i => i.id === current)) {
    $("#reminderApplication").value = current;
  }
}

function openAddReminderModal(applicationId = "", presetDate = "") {
  $("#reminderForm").reset();
  $("#reminderId").value = "";
  $("#reminderDate").value = presetDate || todayKey();
  $("#reminderTime").value = "09:00";
  $("#reminderApplication").value = applicationId || "";
  $("#reminderEmailLead").value = "1440";
  $("#reminderModalTitle").textContent = "新增提醒";
  openModal("reminderModal");
}

function editReminder(id) {
  const item = data.reminders.find(i => i.id === id);
  if (!item) return;

  $("#reminderId").value = item.id;
  $("#reminderTitle").value = item.title;
  $("#reminderDate").value = item.date;
  $("#reminderTime").value = item.time;
  $("#reminderApplication").value = item.applicationId;
  $("#reminderEmailEnabled").checked = item.emailEnabled;
  $("#reminderEmailLead").value = String(item.emailLeadMinutes);
  $("#reminderNote").value = item.note;
  $("#reminderModalTitle").textContent = "编辑提醒";
  openModal("reminderModal");
}

function saveReminderFromForm() {
  if (!$("#reminderForm").reportValidity()) return;

  const id = $("#reminderId").value;
  const date = $("#reminderDate").value;
  const time = $("#reminderTime").value;
  const emailLeadMinutes = Number($("#reminderEmailLead").value);
  const timing = computeReminderTiming(date, time, emailLeadMinutes);
  const now = new Date().toISOString();

  const payload = {
    title: $("#reminderTitle").value.trim(),
    date,
    time,
    applicationId: $("#reminderApplication").value,
    note: $("#reminderNote").value.trim(),
    emailEnabled: $("#reminderEmailEnabled").checked,
    emailLeadMinutes,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    deadlineAt: timing.deadlineAt,
    emailNotifyAt: timing.emailNotifyAt
  };

  if (id) {
    const index = data.reminders.findIndex(i => i.id === id);
    if (index >= 0) {
      data.reminders[index] = {
        ...data.reminders[index],
        ...payload,
        updatedAt: now
      };
    }
  } else {
    data.reminders.push({
      id: createId("rem"),
      ...payload,
      done: false,
      createdAt: now,
      updatedAt: now
    });
  }

  closeModal("reminderModal");
  saveData();
  showToast(payload.emailEnabled ? "提醒已保存，并启用邮件通知" : "提醒已保存");
}

function toggleReminderDone(id) {
  const item = data.reminders.find(i => i.id === id);
  if (!item) return;

  item.done = !item.done;
  item.updatedAt = new Date().toISOString();
  saveData();
}

function deleteReminder(id) {
  if (!confirm("确定删除这个提醒吗？")) return;

  data.reminders = data.reminders.filter(i => i.id !== id);
  saveData();
}

function moveCalendarMonth(offset) {
  calendarCursor = new Date(
    calendarCursor.getFullYear(),
    calendarCursor.getMonth() + offset,
    1
  );
  renderCalendar();
}

function renderCalendar() {
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();

  $("#calendarTitle").textContent = `${year} 年 ${month + 1} 月`;

  const first = new Date(year, month, 1);
  const mondayIndex = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - mondayIndex);
  const cells = [];

  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = toDateKey(d);

    const reminders = data.reminders
      .filter(r => r.date === key)
      .sort((a, b) => (a.time || "").localeCompare(b.time || ""));

    cells.push(`
      <div class="calendar-cell ${d.getMonth() !== month ? "other-month" : ""} ${key === todayKey() ? "today" : ""}" ondblclick="openAddReminderModal('', '${key}')">
        <div class="calendar-day">${d.getDate()}</div>
        ${reminders.slice(0, 4).map(r => `
          <button class="calendar-event ${r.emailEnabled ? "email" : ""} ${r.done ? "done" : ""}" onclick="editReminder('${r.id}')">
            ${escapeHtml(r.time)} ${escapeHtml(r.title)}
          </button>`).join("")}
        ${reminders.length > 4 ? `<div class="company-meta">+${reminders.length - 4} 条</div>` : ""}
      </div>`);
  }

  $("#calendarGrid").innerHTML = cells.join("");
  renderUpcomingReminders();
}

function getUpcomingReminders(days = 30) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + days);

  return data.reminders
    .filter(item => {
      if (item.done || !item.date) return false;
      const d = new Date(`${item.date}T00:00:00`);
      return d >= start && d <= end;
    })
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
}

function renderUpcomingReminders() {
  const overdue = data.reminders
    .filter(i => !i.done && i.date && i.date < todayKey())
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));

  const rows = [...overdue, ...getUpcomingReminders(30)].slice(0, 12);

  $("#upcomingReminderList").innerHTML = rows.length
    ? rows.map(item => {
      const app = getApplicationById(item.applicationId);

      return `
        <div class="mini-item">
          <div class="mini-item-title">${escapeHtml(item.title)} ${item.emailEnabled ? `<span class="email-badge">✉️ 邮件</span>` : ""}</div>
          <div class="mini-item-meta">
            ${item.date < todayKey() ? "已逾期 · " : ""}${escapeHtml(formatDate(item.date))} ${escapeHtml(item.time)}
            ${app ? `<br>${escapeHtml(app.company)} · ${escapeHtml(app.role)}` : ""}
            ${item.emailEnabled ? `<br>邮件：提前 ${formatLead(item.emailLeadMinutes)}` : ""}
          </div>
          <div class="mini-item-actions">
            <button class="btn btn-sm" onclick="toggleReminderDone('${item.id}')">完成</button>
            <button class="btn btn-sm" onclick="editReminder('${item.id}')">编辑</button>
            <button class="btn btn-sm btn-danger" onclick="deleteReminder('${item.id}')">删除</button>
          </div>
        </div>`;
    }).join("")
    : `<div class="muted" style="font-size:10px">暂无近期事项。</div>`;
}

function formatLead(minutes) {
  const value = Number(minutes);
  if (value === 0) return "到点";
  if (value < 60) return `${value} 分钟`;
  if (value < 1440) return `${value / 60} 小时`;
  return `${value / 1440} 天`;
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) {
    alert("当前浏览器不支持系统通知。");
    return;
  }

  const permission = await Notification.requestPermission();
  showToast(permission === "granted" ? "浏览器提醒已开启" : "未开启浏览器提醒");

  if (permission === "granted") checkDueNotifications(true);
}

function checkDueNotifications(force = false) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const sessionKey = `autumn_v3_notified_${currentUser?.id}_${todayKey()}`;

  if (!force && sessionStorage.getItem(sessionKey)) return;

  const now = Date.now();

  const due = data.reminders.filter(item =>
    !item.done &&
    item.deadlineAt &&
    new Date(item.deadlineAt).getTime() <= now
  );

  if (!due.length) return;

  new Notification("秋招 Tracker 提醒", {
    body: `${due[0].title}${due.length > 1 ? `，另有 ${due.length - 1} 条已到期` : ""}`
  });

  sessionStorage.setItem(sessionKey, "1");
}

function exportIcs() {
  const events = data.reminders.filter(i => !i.done && i.date && i.time);

  if (!events.length) {
    alert("没有可导出的未完成提醒。");
    return;
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Autumn Recruitment Tracker V3//CN",
    "CALSCALE:GREGORIAN"
  ];

  events.forEach(item => {
    const date = item.date.replaceAll("-", "");
    const time = item.time.replace(":", "") + "00";
    const app = getApplicationById(item.applicationId);

    lines.push(
      "BEGIN:VEVENT",
      `UID:${item.id}@autumn-tracker`,
      `DTSTART:${date}T${time}`,
      `SUMMARY:${item.title.replaceAll(",", "\\,")}`,
      `DESCRIPTION:${[app ? `${app.company} ${app.role}` : "", item.note].filter(Boolean).join(" - ").replaceAll(",", "\\,")}`,
      "END:VEVENT"
    );
  });

  lines.push("END:VCALENDAR");

  downloadFile(
    lines.join("\r\n"),
    `autumn-recruitment-calendar-${todayKey()}.ics`,
    "text/calendar;charset=utf-8"
  );
}

/* ========== 面试题库 ========== */

function renderQuestionFilters() {
  const filterCurrent = $("#questionCompanyFilter").value;
  const formCurrent = $("#questionCompany").value;

  const options = data.applications
    .slice()
    .sort((a, b) => a.company.localeCompare(b.company, "zh-CN"))
    .map(item => `<option value="${item.id}">${escapeHtml(item.company)} · ${escapeHtml(item.role)}</option>`)
    .join("");

  $("#questionCompanyFilter").innerHTML = `<option value="">全部公司</option>${options}`;
  $("#questionCompany").innerHTML = `<option value="">不关联公司</option>${options}`;

  if (data.applications.some(i => i.id === filterCurrent)) {
    $("#questionCompanyFilter").value = filterCurrent;
  }

  if (data.applications.some(i => i.id === formCurrent)) {
    $("#questionCompany").value = formCurrent;
  }
}

function getFilteredQuestions() {
  const keyword = $("#questionSearch").value.trim().toLowerCase();
  const category = $("#questionCategoryFilter").value;
  const companyId = $("#questionCompanyFilter").value;

  return sortByUpdatedAt(data.questions).filter(item => {
    const text = [
      item.text, item.answer, item.reflection, item.category,
      item.stage, ...item.tags
    ].join(" ").toLowerCase();

    return (
      (!keyword || text.includes(keyword)) &&
      (!category || item.category === category) &&
      (!companyId || item.companyApplicationId === companyId)
    );
  });
}

function renderQuestions() {
  const rows = getFilteredQuestions();
  const difficulty = { easy: "基础", medium: "中等", hard: "困难" };

  if (!rows.length) {
    $("#questionGrid").innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="empty-emoji">🧠</div>
        <div class="empty-title">${data.questions.length ? "没有符合条件的记录" : "题库还是空的"}</div>
      </div>`;
    return;
  }

  $("#questionGrid").innerHTML = rows.map(item => {
    const app = getApplicationById(item.companyApplicationId);

    return `
      <article class="question-card">
        <div class="question-top">
          <div>
            <div class="question-category">${escapeHtml(item.category)}</div>
            <h3 class="question-title">${escapeHtml(item.text)}</h3>
            <div class="company-meta">${app ? `${escapeHtml(app.company)} · ${escapeHtml(app.role)}` : "通用题库"}${item.stage ? ` · ${escapeHtml(item.stage)}` : ""}</div>
          </div>
          <span class="difficulty-badge difficulty-${item.difficulty}">${difficulty[item.difficulty]}</span>
        </div>
        ${item.answer ? `<div class="question-section"><strong>答案思路</strong><p>${escapeHtml(item.answer)}</p></div>` : ""}
        ${item.reflection ? `<div class="question-section"><strong>我的复盘</strong><p>${escapeHtml(item.reflection)}</p></div>` : ""}
        ${item.tags.length ? `<div class="question-tags">${item.tags.map(tag => `<span class="question-tag">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
        <div class="question-actions">
          <button class="btn btn-sm" onclick="editQuestion('${item.id}')">编辑</button>
          <button class="btn btn-sm btn-danger" onclick="deleteQuestion('${item.id}')">删除</button>
        </div>
      </article>`;
  }).join("");
}

function openAddQuestionModal() {
  $("#questionForm").reset();
  $("#questionId").value = "";
  $("#questionCategory").value = QUESTION_CATEGORIES[0];
  $("#questionDifficulty").value = "medium";
  $("#questionModalTitle").textContent = "新增面试记录";
  openModal("questionModal");
}

function editQuestion(id) {
  const item = data.questions.find(i => i.id === id);
  if (!item) return;

  $("#questionId").value = item.id;
  $("#questionCategory").value = item.category;
  $("#questionDifficulty").value = item.difficulty;
  $("#questionCompany").value = item.companyApplicationId;
  $("#questionStage").value = item.stage;
  $("#questionText").value = item.text;
  $("#questionAnswer").value = item.answer;
  $("#questionReflection").value = item.reflection;
  $("#questionTags").value = item.tags.join(", ");
  $("#questionModalTitle").textContent = "编辑面试记录";
  openModal("questionModal");
}

function saveQuestionFromForm() {
  if (!$("#questionForm").reportValidity()) return;

  const id = $("#questionId").value;
  const now = new Date().toISOString();

  const payload = {
    category: $("#questionCategory").value,
    difficulty: $("#questionDifficulty").value,
    companyApplicationId: $("#questionCompany").value,
    stage: $("#questionStage").value.trim(),
    text: $("#questionText").value.trim(),
    answer: $("#questionAnswer").value.trim(),
    reflection: $("#questionReflection").value.trim(),
    tags: $("#questionTags").value
      .split(/[,，]/)
      .map(tag => tag.trim())
      .filter(Boolean)
  };

  if (id) {
    const index = data.questions.findIndex(i => i.id === id);
    if (index >= 0) {
      data.questions[index] = {
        ...data.questions[index],
        ...payload,
        updatedAt: now
      };
    }
  } else {
    data.questions.unshift({
      id: createId("q"),
      ...payload,
      createdAt: now,
      updatedAt: now
    });
  }

  closeModal("questionModal");
  saveData();
}

function deleteQuestion(id) {
  if (!confirm("确定删除这条面试记录吗？")) return;

  data.questions = data.questions.filter(i => i.id !== id);
  saveData();
}

/* ========== 备份与恢复 ========== */

function exportJson() {
  downloadFile(
    JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2),
    `autumn-recruitment-v3-backup-${todayKey()}.json`,
    "application/json;charset=utf-8"
  );
}

function exportCsv() {
  const headers = [
    "公司", "岗位", "岗位类型", "优先级", "投递时间",
    "投递渠道", "地点", "薪资", "状态", "最终结果", "备注"
  ];

  const rows = data.applications.map(item => [
    item.company,
    item.role,
    item.roleType,
    PRIORITY_MAP[item.priority],
    item.applyDate,
    item.channel,
    item.location,
    item.salary,
    STATUS_MAP[item.status],
    item.expectedResult,
    item.note
  ]);

  const csv = [headers, ...rows]
    .map(row => row.map(csvEscape).join(","))
    .join("\n");

  downloadFile(
    "\uFEFF" + csv,
    `autumn-recruitment-v3-${todayKey()}.csv`,
    "text/csv;charset=utf-8"
  );
}

async function importJson(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const parsed = JSON.parse(await file.text());

    if (!confirm("导入会覆盖当前账号在这台电脑的本地数据，是否继续？")) return;

    data = normalizeData(parsed);
    saveData();
    closeModal("backupModal");
    showToast("数据已导入并准备同步");
  } catch (error) {
    alert(`导入失败：${error.message}`);
  } finally {
    event.target.value = "";
  }
}

/* ========== 全局暴露 ========== */

window.openDrawer = openDrawer;
window.editApplication = editApplication;
window.deleteApplication = deleteApplication;
window.openAddStageModal = openAddStageModal;
window.openEditStageModal = openEditStageModal;
window.deleteStage = deleteStage;
window.stageToQuestion = stageToQuestion;
window.openAddReminderModal = openAddReminderModal;
window.editReminder = editReminder;
window.toggleReminderDone = toggleReminderDone;
window.deleteReminder = deleteReminder;
window.editQuestion = editQuestion;
window.deleteQuestion = deleteQuestion;
