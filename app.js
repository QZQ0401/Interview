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
  ["terminated", "已终止"],
  ["silent", "无回应"],
  ["withdrawn", "主动放弃"]
];

const PRIORITY_OPTIONS = [
  ["high", "高优先级"],
  ["medium", "中优先级"],
  ["low", "低优先级"]
];

const QUESTION_CATEGORIES = [
  "Ros2_Code 源码专项",
  "简历 / 项目深挖",
  "机器人运动学与标定",
  "机器人动力学与控制",
  "运动规划与轨迹优化",
  "ROS2 / DDS",
  "MoveIt2 / OMPL / STOMP",
  "ros2_control / 实时控制",
  "C++ / 多线程与并发",
  "数学 / 优化 / 参数辨识",
  "机器人系统设计 / 工程化",
  "算法", "操作系统", "计算机网络", "系统设计",
  "Java / JVM", "数据库", "项目经历", "行为面 / HR", "其他"
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
  terminated: "#8f6a58",
  silent: "#6b7280",
  withdrawn: "#9a6546"
};

const CONFIG = window.APP_CONFIG || {};
const APP_URL = CONFIG.APP_URL || window.location.origin + window.location.pathname;

const RESUME_BUCKET = "resumes";
const RESUME_MAX_FILE_BYTES = 10 * 1024 * 1024;
const RESUME_MAX_PAGES = 12;
const PDFJS_MODULE_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs";
const PDFJS_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs";

let supabase = null;
let currentUser = null;
let data = createEmptyData();
let activeApplicationId = null;

let activeQuestionDetailId = null;
let questionDetailEditMode = false;
let activeResumeId = null;
let resumePreviewRenderToken = 0;
let pendingApplicationImport = null;

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
    questions: [],
    resumes: []
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
      : [],
    resumes: Array.isArray(source.resumes)
      ? source.resumes.map(normalizeResume)
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
    sourceTitle: item.sourceTitle || "",
    sourceUrl: item.sourceUrl || "",
    createdAt: item.createdAt || now,
    updatedAt: item.updatedAt || now
  };
}

function normalizeResume(item = {}) {
  const now = new Date().toISOString();
  const kind = ["pdf", "docx"].includes(item.kind) ? item.kind : "pdf";

  return {
    id: item.id || createId("resume"),
    name: item.name || item.fileName || "未命名简历",
    fileName: item.fileName || "",
    kind,
    fileSize: Number(item.fileSize) || 0,
    pageCount: Number(item.pageCount) || 0,
    originalPath: item.originalPath || "",
    previewPaths: Array.isArray(item.previewPaths)
      ? item.previewPaths.filter(Boolean)
      : [],
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
      data.applications.length +
      data.reminders.length +
      data.questions.length +
      data.resumes.length;
    const cloudCount =
      cloudData.applications.length +
      cloudData.reminders.length +
      cloudData.questions.length +
      cloudData.resumes.length;

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
  $("#importApplicationsBtn").addEventListener("click", () => $("#applicationImportFile").click());
  $("#applicationImportFile").addEventListener("change", handleApplicationImportFile);
  $("#applicationImportMode").addEventListener("change", renderApplicationImportPreview);
  $("#confirmApplicationImportBtn").addEventListener("click", confirmApplicationImport);
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
  $("#importBuiltinQuestionBankBtn").addEventListener("click", importBuiltinQuestionBank);
  $("#importQuestionBankBtn").addEventListener("click", () => $("#questionBankFile").click());
  $("#questionBankFile").addEventListener("change", importQuestionBankJson);

  $("#questionDetailEditBtn").addEventListener("click", () => setQuestionDetailEditMode(true));
  $("#questionDetailCancelEditBtn").addEventListener("click", () => setQuestionDetailEditMode(false));
  $("#questionDetailSaveBtn").addEventListener("click", saveQuestionDetailEdits);
  $("#questionDetailDeleteBtn").addEventListener("click", deleteQuestionFromDetail);
  $("#questionSearch").addEventListener("input", renderQuestions);
  $("#questionCategoryFilter").addEventListener("change", () => {
    renderQuestionModules();
    renderQuestions();
  });
  $("#questionCompanyFilter").addEventListener("change", renderQuestions);

  $("#uploadResumeBtn").addEventListener("click", () => $("#resumeFile").click());
  $("#resumeEmptyUploadBtn").addEventListener("click", () => $("#resumeFile").click());
  $("#resumeFile").addEventListener("change", handleResumeUpload);
  $("#resumeList").addEventListener("click", event => {
    const button = event.target.closest("[data-resume-id]");
    if (!button) return;

    activeResumeId = button.dataset.resumeId;
    renderResume();
  });
  $("#downloadResumeBtn").addEventListener("click", downloadActiveResume);
  $("#deleteResumeBtn").addEventListener("click", deleteActiveResume);

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
  if (view === "resume") renderResume();
}

function renderAll() {
  if (!currentUser) return;

  renderDashboard();
  renderApplicationFilters();
  renderApplications();
  renderReminderApplicationOptions();
  renderCalendar();
  renderQuestionFilters();
  renderQuestionModules();
  renderQuestions();
  renderResumeList();
  if ($("#view-resume")?.classList.contains("active")) renderResume();
  refreshQuestionDetailIfOpen();
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
      <thead><tr><th>公司 / 岗位</th><th>网站链接</th><th>投递时间</th><th>状态</th><th>当前进度</th><th>地点</th><th>最近更新</th><th>操作</th></tr></thead>
      <tbody>
        ${rows.map(item => {
          const latestStage = [...item.stages]
            .sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
          const jobUrl = String(item.jobUrl || "").trim();
          const safeJobUrl = /^https?:\/\//i.test(jobUrl) ? jobUrl : "";

          return `
            <tr>
              <td><div class="company-cell"><div class="company-avatar">${escapeHtml(getInitial(item.company))}</div><div><button class="link-button" onclick="openDrawer('${item.id}')">${escapeHtml(item.company)}</button><div class="company-meta">${escapeHtml(item.role)}</div></div></div></td>
              <td>${safeJobUrl ? `<a class="link-button" href="${escapeHtml(safeJobUrl)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;white-space:nowrap">打开网站 ↗</a>` : "—"}</td>
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

/* ========== V3.4 外部投递导入 ========== */

const APPLICATION_IMPORT_ALIASES = {
  company: ["company", "公司", "企业", "公司名称", "企业名称", "employer"],
  role: ["role", "岗位", "职位", "岗位名称", "职位名称", "position", "job", "jobTitle"],
  roleType: ["roleType", "岗位类型", "职位类型", "类型", "jobType"],
  applyDate: ["applyDate", "投递时间", "投递日期", "申请日期", "申请时间", "date"],
  channel: ["channel", "投递渠道", "申请渠道", "渠道"],
  location: ["location", "工作地点", "地点", "城市", "工作城市", "city"],
  salary: ["salary", "薪资", "薪资范围", "待遇"],
  priority: ["priority", "优先级", "公司优先级"],
  status: ["status", "投递状态", "申请状态", "状态"],
  expectedResult: ["expectedResult", "最终结果", "结果"],
  jobUrl: ["jobUrl", "岗位链接", "职位链接", "招聘链接", "投递链接", "链接", "url"],
  note: ["note", "notes", "备注", "说明"],
  raw: ["原始信息", "raw", "rawInfo", "sourceText", "原文", "原始文本"]
};

const APPLICATION_IMPORT_CITIES = [
  "北京", "上海", "深圳", "广州", "杭州", "苏州", "东莞", "武汉", "珠海", "佛山",
  "合肥", "济南", "青岛", "潮州", "成都", "天津", "宁波", "厦门", "福州", "长沙",
  "惠州", "南京", "重庆", "西安", "无锡", "常州", "南通", "郑州", "沈阳", "大连",
  "烟台", "昆山", "嘉兴", "绍兴"
];

const APPLICATION_IMPORT_STATUS_WEIGHT = {
  preparing: 10,
  silent: 15,
  applied: 20,
  test: 40,
  interview: 50,
  hr: 60,
  rejected: 80,
  withdrawn: 80,
  terminated: 85,
  offer: 100
};

function cleanApplicationImportText(value) {
  return String(value ?? "")
    .replace(/\uFEFF/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeApplicationImportKey(value) {
  return cleanApplicationImportText(value)
    .toLowerCase()
    .replace(/[\s_\-—:：/／（）()]+/g, "");
}

function pickApplicationImportValue(row, aliases) {
  if (!row || typeof row !== "object") return "";

  const normalized = new Map(
    Object.entries(row).map(([key, value]) => [normalizeApplicationImportKey(key), value])
  );

  for (const alias of aliases) {
    const key = normalizeApplicationImportKey(alias);
    if (normalized.has(key)) return normalized.get(key);
  }
  return "";
}

function escapeApplicationImportRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeApplicationImportDate(value, rawText = "") {
  const candidates = [value, rawText]
    .map(cleanApplicationImportText)
    .filter(Boolean);

  for (const candidate of candidates) {
    const match = candidate.match(
      /(20\d{2})[./-](\d{1,2})[./-](\d{1,2})(?:\s+(\d))?/
    );
    if (!match) continue;

    const year = Number(match[1]);
    const month = Number(match[2]);
    let dayText = match[3];

    if (
      match[4] &&
      dayText.length === 1 &&
      Number(`${dayText}${match[4]}`) <= 31
    ) {
      dayText += match[4];
    }

    const day = Number(dayText);
    const date = new Date(year, month - 1, day);

    if (
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
    ) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  return "";
}

function getApplicationImportCityPattern() {
  return APPLICATION_IMPORT_CITIES
    .map(escapeApplicationImportRegExp)
    .sort((a, b) => b.length - a.length)
    .join("|");
}

function inferApplicationImportLocation(explicitValue, rawText) {
  const explicit = cleanApplicationImportText(explicitValue);
  if (explicit && !["没有", "暂无", "无", "null", "undefined"].includes(explicit.toLowerCase())) {
    return explicit;
  }

  let head = cleanApplicationImportText(rawText);
  head = head.split(/20\d{2}[./-]\d{1,2}[./-]\d{1,2}/)[0].trim();

  const shorthand = head.match(/(?:苏\/北\/上|武\/深\/厦)\s*$/);
  if (shorthand) return shorthand[0].trim();

  const cityPattern = getApplicationImportCityPattern();
  const match = head.match(new RegExp(`((?:${cityPattern})(?:[/／](?:${cityPattern}))*)\\s*$`));
  return match ? match[1] : "";
}

function inferApplicationImportRole(explicitValue, company, rawText, location) {
  const explicit = cleanApplicationImportText(explicitValue);
  if (explicit) return explicit;

  let text = cleanApplicationImportText(rawText);
  if (!text) return "待补充岗位";

  text = text.split(/20\d{2}[./-]\d{1,2}[./-]\d{1,2}/)[0].trim();

  if (company) {
    text = text.replace(new RegExp(escapeApplicationImportRegExp(company), "ig"), " ");
  }

  text = text
    .replace(/(?:正式批|提前批|秋招|校招|春招|补录|社会招聘|校园招聘)/gi, " ")
    .replace(/(^|\s)[^\s]{1,12}招聘(?=\s|$)/g, " ")
    .replace(/招聘|招\s*聘/g, " ");

  if (normalizeApplicationImportKey(company) === "tplink") {
    text = text.replace(/^\s*(?:普联\s*)?(?:TP普联\s*)?/i, "");
  }

  const cityPattern = getApplicationImportCityPattern();
  text = text.replace(
    new RegExp(`\\s+(?:${cityPattern})(?:[/／](?:${cityPattern}))*\\s*$`),
    " "
  );
  text = text.replace(/\s+(?:苏\/北\/上|武\/深\/厦)\s*$/, " ");

  if (location) {
    text = text.replace(
      new RegExp(`\\s*${escapeApplicationImportRegExp(location)}\\s*$`, "i"),
      " "
    );
  }

  text = text
    .replace(new RegExp(`\\s+(?:${cityPattern})[/／]?\\s*$`), " ")
    .replace(/\s+(?:没有|暂无|无)\s*$/, " ");

  text = cleanApplicationImportText(text);
  return text || "待补充岗位";
}

function normalizeApplicationImportPriority(value) {
  const text = cleanApplicationImportText(value).toLowerCase();
  if (["high", "高", "高优先级", "重要"].includes(text)) return "high";
  if (["low", "低", "低优先级"].includes(text)) return "low";
  return "medium";
}

function normalizeApplicationImportStatus(value, rawText = "") {
  const explicit = cleanApplicationImportText(value);
  if (STATUS_MAP[explicit]) return explicit;

  const text = cleanApplicationImportText(`${explicit} ${rawText}`);

  if (/终止|已终止/.test(text)) return "terminated";
  if (/offer|录用|已录用/i.test(text)) return "offer";
  if (/HR\s*面/i.test(text)) return "hr";
  if (/(?:一面|二面|三面|终面|面试).{0,3}(?:挂|未通过)|拒绝|淘汰|未通过/.test(text)) {
    return "rejected";
  }
  if (/AI\s*面?|一面|二面|三面|四面|终面|技术面|面试/i.test(text)) {
    return "interview";
  }
  if (/笔试|测评|机考|在线测试|\/笔(?:\s|$)/.test(text)) return "test";
  if (/主动放弃|放弃/.test(text)) return "withdrawn";
  if (/无回应|没回应|暂无回应/.test(text)) return "silent";
  if (/已投递|投递成功|已申请|申请成功/.test(text)) return "applied";
  if (/准备投递|待投递|未投递|准备/.test(text)) return "preparing";

  return explicit ? "applied" : "preparing";
}

function inferApplicationImportStage(rawText, now) {
  const raw = cleanApplicationImportText(rawText);
  if (!raw) return null;

  const candidates = [
    { regex: /HR\s*面/i, name: "HR 面" },
    { regex: /终面/, name: "终面" },
    { regex: /三面/, name: "三面" },
    { regex: /二面/, name: "二面" },
    { regex: /一面/, name: "一面" },
    { regex: /AI\s*面?|\/AI(?:\s|$)/i, name: "AI 面" },
    { regex: /笔试|已测评\/笔|\/笔(?:\s|$)/, name: "笔试" },
    { regex: /测评|在线测试/, name: "测评" }
  ];

  const matched = candidates.find(item => item.regex.test(raw));
  if (!matched) return null;

  return {
    id: createId("stage"),
    name: matched.name,
    date: "",
    result: /(?:挂|未通过|淘汰|拒绝)/.test(raw) ? "未通过" : "已完成",
    format: "",
    interviewer: "",
    duration: "",
    questions: "",
    reflection: "",
    notes: "由外部投递文件自动识别",
    createdAt: now,
    updatedAt: now
  };
}

function buildApplicationImportNote(noteValue, rawText, statusValue) {
  const parts = [];
  const note = cleanApplicationImportText(noteValue);
  const raw = cleanApplicationImportText(rawText);
  const status = cleanApplicationImportText(statusValue);

  if (note) parts.push(note);
  if (raw && !parts.includes(raw)) parts.push(`外部导入原始信息：${raw}`);
  if (status && !raw && !parts.some(item => item.includes(status))) {
    parts.push(`外部状态：${status}`);
  }

  return parts.join("\n");
}

function convertExternalApplicationRow(row) {
  const company = cleanApplicationImportText(
    pickApplicationImportValue(row, APPLICATION_IMPORT_ALIASES.company)
  );
  if (!company) return null;

  const rawText = cleanApplicationImportText(
    pickApplicationImportValue(row, APPLICATION_IMPORT_ALIASES.raw)
  );
  const explicitLocation = pickApplicationImportValue(
    row,
    APPLICATION_IMPORT_ALIASES.location
  );
  const location = inferApplicationImportLocation(explicitLocation, rawText);
  const role = inferApplicationImportRole(
    pickApplicationImportValue(row, APPLICATION_IMPORT_ALIASES.role),
    company,
    rawText,
    location
  );
  const explicitStatus = pickApplicationImportValue(
    row,
    APPLICATION_IMPORT_ALIASES.status
  );
  const now = new Date().toISOString();
  const stage = inferApplicationImportStage(rawText, now);

  return normalizeApplication({
    company,
    role,
    roleType: cleanApplicationImportText(
      pickApplicationImportValue(row, APPLICATION_IMPORT_ALIASES.roleType)
    ),
    applyDate: normalizeApplicationImportDate(
      pickApplicationImportValue(row, APPLICATION_IMPORT_ALIASES.applyDate),
      rawText
    ),
    channel: cleanApplicationImportText(
      pickApplicationImportValue(row, APPLICATION_IMPORT_ALIASES.channel)
    ),
    location,
    salary: cleanApplicationImportText(
      pickApplicationImportValue(row, APPLICATION_IMPORT_ALIASES.salary)
    ),
    priority: normalizeApplicationImportPriority(
      pickApplicationImportValue(row, APPLICATION_IMPORT_ALIASES.priority)
    ),
    status: normalizeApplicationImportStatus(explicitStatus, rawText),
    expectedResult: cleanApplicationImportText(
      pickApplicationImportValue(row, APPLICATION_IMPORT_ALIASES.expectedResult)
    ) || (/终止/.test(cleanApplicationImportText(explicitStatus)) ? "终止" : ""),
    jobUrl: cleanApplicationImportText(
      pickApplicationImportValue(row, APPLICATION_IMPORT_ALIASES.jobUrl)
    ),
    note: buildApplicationImportNote(
      pickApplicationImportValue(row, APPLICATION_IMPORT_ALIASES.note),
      rawText,
      explicitStatus
    ),
    createdAt: now,
    updatedAt: now,
    stages: stage ? [stage] : []
  });
}

function applicationImportIdentityPart(value) {
  return cleanApplicationImportText(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·•_—\-–/／（）()【】[\],，.。:：;；]+/g, "");
}

function applicationImportRoleFingerprint(role) {
  const cityPattern = getApplicationImportCityPattern();
  let value = applicationImportIdentityPart(role);

  if (value === applicationImportIdentityPart("待补充岗位")) return "";

  value = value
    .replace(/工程师/g, "工程")
    .replace(/没有|暂无|无/g, "")
    .replace(new RegExp(cityPattern, "g"), "");

  return value;
}

function sameApplicationImportIdentity(a, b) {
  const companyA = applicationImportIdentityPart(a.company);
  const companyB = applicationImportIdentityPart(b.company);
  if (!companyA || companyA !== companyB) return false;

  const roleA = applicationImportRoleFingerprint(a.role);
  const roleB = applicationImportRoleFingerprint(b.role);

  if (!roleA || !roleB) return true;
  if (roleA === roleB) return true;

  if (roleA.includes(roleB) || roleB.includes(roleA)) {
    return Math.abs(roleA.length - roleB.length) <= 3;
  }

  return false;
}

function joinUniqueApplicationImportNotes(a, b) {
  const rows = `${a || ""}\n${b || ""}`
    .split("\n")
    .map(item => item.trim())
    .filter(Boolean);

  return [...new Set(rows)].join("\n");
}

function mergeApplicationImportStages(a, b) {
  const result = [...(a || [])];

  for (const stage of b || []) {
    const exists = result.some(item =>
      cleanApplicationImportText(item.name) === cleanApplicationImportText(stage.name) &&
      cleanApplicationImportText(item.date) === cleanApplicationImportText(stage.date)
    );
    if (!exists) result.push(stage);
  }

  return result;
}

function pickBetterApplicationImportRole(a, b) {
  const first = cleanApplicationImportText(a);
  const second = cleanApplicationImportText(b);

  if (!first || first === "待补充岗位") return second || first || "待补充岗位";
  if (!second || second === "待补充岗位") return first;

  return applicationImportRoleFingerprint(second).length >
    applicationImportRoleFingerprint(first).length
    ? second
    : first;
}

function mergeImportedApplication(base, incoming, existingWins = false) {
  const now = new Date().toISOString();
  const baseWeight = APPLICATION_IMPORT_STATUS_WEIGHT[base.status] || 0;
  const incomingWeight = APPLICATION_IMPORT_STATUS_WEIGHT[incoming.status] || 0;
  const nextStatus = incomingWeight > baseWeight ? incoming.status : base.status;

  if (existingWins) {
    return normalizeApplication({
      ...base,
      role: base.role || incoming.role,
      roleType: base.roleType || incoming.roleType,
      applyDate: base.applyDate || incoming.applyDate,
      channel: base.channel || incoming.channel,
      location: base.location || incoming.location,
      salary: base.salary || incoming.salary,
      priority: base.priority || incoming.priority,
      status: nextStatus,
      expectedResult: base.expectedResult || incoming.expectedResult,
      jobUrl: base.jobUrl || incoming.jobUrl,
      note: joinUniqueApplicationImportNotes(base.note, incoming.note),
      stages: mergeApplicationImportStages(base.stages, incoming.stages),
      createdAt: base.createdAt || incoming.createdAt || now,
      updatedAt: now
    });
  }

  const dates = [base.applyDate, incoming.applyDate].filter(Boolean).sort();

  return normalizeApplication({
    ...base,
    role: pickBetterApplicationImportRole(base.role, incoming.role),
    roleType: incoming.roleType || base.roleType,
    applyDate: dates[0] || "",
    channel: incoming.channel || base.channel,
    location: incoming.location || base.location,
    salary: incoming.salary || base.salary,
    priority: incoming.priority || base.priority,
    status: nextStatus,
    expectedResult: incoming.expectedResult || base.expectedResult,
    jobUrl: incoming.jobUrl || base.jobUrl,
    note: joinUniqueApplicationImportNotes(base.note, incoming.note),
    stages: mergeApplicationImportStages(base.stages, incoming.stages),
    createdAt: base.createdAt || incoming.createdAt || now,
    updatedAt: now
  });
}

function dedupeImportedApplications(applications) {
  const merged = [];

  for (const item of applications) {
    const index = merged.findIndex(existing =>
      sameApplicationImportIdentity(existing, item)
    );

    if (index >= 0) {
      merged[index] = mergeImportedApplication(merged[index], item, false);
    } else {
      merged.push(item);
    }
  }

  return merged;
}

function extractApplicationImportRows(parsed) {
  if (Array.isArray(parsed)) return parsed;

  if (parsed && typeof parsed === "object") {
    const preferredKeys = ["applications", "rows", "items", "records", "data"];

    for (const key of preferredKeys) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }

    const firstArray = Object.values(parsed).find(value => Array.isArray(value));
    if (firstArray) return firstArray;
  }

  throw new Error("没有找到可导入的投递数组。JSON 可以直接是数组，也可以包含 applications / rows / items / records / data 数组。");
}

function parseApplicationImportCsv(text) {
  const input = String(text || "").replace(/^\uFEFF/, "");
  const firstLine = input.split(/\r?\n/, 1)[0] || "";
  const delimiter = firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (!quoted && char === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some(value => cleanApplicationImportText(value))) rows.push(row);
      row = [];
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some(value => cleanApplicationImportText(value))) rows.push(row);

  if (rows.length < 2) {
    throw new Error("CSV 中没有可导入的数据行。");
  }

  const headers = rows[0].map(cleanApplicationImportText);
  return rows.slice(1).map(values => {
    const record = {};
    headers.forEach((header, index) => {
      if (header) record[header] = values[index] ?? "";
    });
    return record;
  });
}

async function parseApplicationImportFile(file) {
  const text = await file.text();
  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith(".csv") || file.type === "text/csv") {
    return parseApplicationImportCsv(text);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON 格式不正确：${error.message}`);
  }

  return extractApplicationImportRows(parsed);
}

function getApplicationImportImpact(applications, mode) {
  if (mode === "append") {
    return { added: applications.length, merged: 0 };
  }

  const simulated = [...data.applications];
  let added = 0;
  let merged = 0;

  for (const item of applications) {
    const index = simulated.findIndex(existing =>
      sameApplicationImportIdentity(existing, item)
    );

    if (index >= 0) {
      simulated[index] = mergeImportedApplication(simulated[index], item, true);
      merged += 1;
    } else {
      simulated.push(item);
      added += 1;
    }
  }

  return { added, merged };
}

function renderApplicationImportPreview() {
  if (!pendingApplicationImport) return;

  const mode = $("#applicationImportMode").value;
  const impact = getApplicationImportImpact(
    pendingApplicationImport.applications,
    mode
  );

  $("#applicationImportFileName").textContent = pendingApplicationImport.fileName;
  $("#applicationImportRawCount").textContent = String(pendingApplicationImport.rawCount);
  $("#applicationImportParsedCount").textContent = String(
    pendingApplicationImport.applications.length
  );
  $("#applicationImportActionCount").textContent =
    `${impact.added} 新增 / ${impact.merged} 合并`;

  const warnings = [];
  if (pendingApplicationImport.collapsedCount > 0) {
    warnings.push(
      `文件内识别到 ${pendingApplicationImport.collapsedCount} 条重复/补充行，已自动合并。`
    );
  }
  if (pendingApplicationImport.invalidCount > 0) {
    warnings.push(
      `${pendingApplicationImport.invalidCount} 行缺少公司名称，已跳过。`
    );
  }

  $("#applicationImportWarnings").innerHTML = warnings.length
    ? warnings.map(item => `<div>• ${escapeHtml(item)}</div>`).join("")
    : `<div>字段识别正常，可直接导入。</div>`;

  const preview = pendingApplicationImport.applications.slice(0, 10);
  $("#applicationImportPreview").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>公司 / 岗位</th>
          <th>投递日期</th>
          <th>状态</th>
          <th>地点</th>
          <th>识别进度</th>
        </tr>
      </thead>
      <tbody>
        ${preview.map(item => `
          <tr>
            <td>
              <strong>${escapeHtml(item.company)}</strong>
              <div class="company-meta">${escapeHtml(item.role || "待补充岗位")}</div>
            </td>
            <td>${escapeHtml(item.applyDate || "—")}</td>
            <td><span class="status-badge status-${item.status}">${escapeHtml(STATUS_MAP[item.status] || item.status)}</span></td>
            <td>${escapeHtml(item.location || "—")}</td>
            <td>${escapeHtml(item.stages?.[0]?.name || "—")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    ${pendingApplicationImport.applications.length > preview.length
      ? `<div class="import-preview-more">仅预览前 ${preview.length} 条，共 ${pendingApplicationImport.applications.length} 条。</div>`
      : ""}
  `;
}

async function handleApplicationImportFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const rows = await parseApplicationImportFile(file);
    const converted = rows
      .map(convertExternalApplicationRow)
      .filter(Boolean);

    if (!converted.length) {
      throw new Error("没有识别到有效投递。至少需要“企业 / 公司 / company”字段。");
    }

    const applications = dedupeImportedApplications(converted);

    pendingApplicationImport = {
      fileName: file.name,
      rawCount: rows.length,
      invalidCount: rows.length - converted.length,
      collapsedCount: converted.length - applications.length,
      applications
    };

    $("#applicationImportMode").value = "merge";
    renderApplicationImportPreview();
    openModal("applicationImportModal");
  } catch (error) {
    alert(`投递导入失败：${error.message}`);
  } finally {
    event.target.value = "";
  }
}

function confirmApplicationImport() {
  if (!pendingApplicationImport?.applications?.length) return;

  const mode = $("#applicationImportMode").value;
  let added = 0;
  let merged = 0;

  for (const imported of pendingApplicationImport.applications) {
    const incoming = normalizeApplication({
      ...imported,
      id: createId("app"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    if (mode === "merge") {
      const index = data.applications.findIndex(existing =>
        sameApplicationImportIdentity(existing, incoming)
      );

      if (index >= 0) {
        data.applications[index] = mergeImportedApplication(
          data.applications[index],
          incoming,
          true
        );
        merged += 1;
        continue;
      }
    }

    data.applications.unshift(incoming);
    added += 1;
  }

  closeModal("applicationImportModal");
  pendingApplicationImport = null;
  saveData();
  showToast(`导入完成：新增 ${added} 条，合并 ${merged} 条`);
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

function renderQuestionModules() {
  const root = $("#questionModuleGrid");
  if (!root) return;

  const current = $("#questionCategoryFilter").value;
  const modules = QUESTION_CATEGORIES
    .map(category => ({
      category,
      count: data.questions.filter(item => item.category === category).length
    }))
    .filter(item => item.count > 0);

  root.innerHTML = [
    `<button class="question-module-chip ${current === "" ? "active" : ""}" data-question-module="">
       <span>全部</span><strong>${data.questions.length}</strong>
     </button>`,
    ...modules.map(item => `
      <button class="question-module-chip ${current === item.category ? "active" : ""}"
              data-question-module="${escapeHtml(item.category)}">
        <span>${escapeHtml(item.category)}</span><strong>${item.count}</strong>
      </button>`)
  ].join("");

  root.querySelectorAll("[data-question-module]").forEach(button => {
    button.addEventListener("click", () => {
      $("#questionCategoryFilter").value = button.dataset.questionModule || "";
      renderQuestionModules();
      renderQuestions();
    });
  });
}

function getFilteredQuestions() {
  const keyword = $("#questionSearch").value.trim().toLowerCase();
  const category = $("#questionCategoryFilter").value;
  const companyId = $("#questionCompanyFilter").value;

  return sortByUpdatedAt(data.questions).filter(item => {
    const text = [
      item.text, item.answer, item.reflection, item.category,
      item.stage, item.sourceTitle, ...item.tags
    ].join(" ").toLowerCase();

    return (
      (!keyword || text.includes(keyword)) &&
      (!category || item.category === category) &&
      (!companyId || item.companyApplicationId === companyId)
    );
  });
}

function getQuestionHeadline(text = "") {
  const first = String(text)
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || "未命名题目";
  return first.replace(/^主问题\s*[:：]\s*/u, "").trim() || "未命名题目";
}

function getQuestionLines(text = "") {
  return String(text)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function stripQuestionLinePrefix(line = "") {
  return String(line)
    .replace(/^主问题\s*[:：]\s*/u, "")
    .replace(/^追问\s*\d*\s*(?:（[^）]*）|\([^)]*\))?\s*[:：]\s*/u, "")
    .trim();
}

function getQuestionFollowupCount(text = "") {
  const lines = getQuestionLines(text);
  const explicit = lines.filter(line => /^追问/u.test(line)).length;
  return explicit || Math.max(0, lines.length - 1);
}

function getQuestionPreview(text = "") {
  return getQuestionLines(text)
    .slice(1, 3)
    .map(stripQuestionLinePrefix)
    .filter(Boolean)
    .join(" · ");
}

function safeExternalUrl(value = "") {
  if (!value) return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function renderQuestionPromptBlocks(text = "") {
  const lines = getQuestionLines(text);
  if (!lines.length) {
    return `<div class="question-detail-empty">暂无题目内容</div>`;
  }

  return lines.map((line, index) => {
    const match = line.match(/^(主问题|追问\s*\d*(?:（[^）]*）|\([^)]*\))?)\s*[:：]\s*(.*)$/u);
    const label = match?.[1] || (index === 0 ? "主问题" : `追问 ${index}`);
    const body = match?.[2] || line;

    if (index === 0) {
      return `
        <div class="question-detail-main-prompt">
          <span>${escapeHtml(label)}</span>
          <p>${escapeHtml(body)}</p>
        </div>`;
    }

    return `
      <div class="question-detail-followup">
        <span>${escapeHtml(label)}</span>
        <p>${escapeHtml(body)}</p>
      </div>`;
  }).join("");
}

function renderQuestionTextContent(value = "", emptyText = "暂无内容") {
  if (!String(value || "").trim()) {
    return `<div class="question-detail-empty">${escapeHtml(emptyText)}</div>`;
  }
  return `<div class="question-detail-prose">${escapeHtml(value).replace(/\n/g, "<br>")}</div>`;
}

function renderQuestions() {
  const rows = getFilteredQuestions();
  const difficulty = { easy: "基础", medium: "中等", hard: "困难" };

  if (!rows.length) {
    $("#questionGrid").innerHTML = `
      <div class="empty-state">
        <div class="empty-emoji">🧠</div>
        <div class="empty-title">${data.questions.length ? "没有符合条件的记录" : "题库还是空的"}</div>
      </div>`;
    return;
  }

  $("#questionGrid").innerHTML = rows.map(item => {
    const app = getApplicationById(item.companyApplicationId);
    const headline = getQuestionHeadline(item.text);
    const preview = getQuestionPreview(item.text);
    const followups = getQuestionFollowupCount(item.text);
    const tags = item.tags.slice(0, 6);

    return `
      <article
        class="question-card question-card-clickable"
        data-question-id="${escapeHtml(item.id)}"
        tabindex="0"
        role="button"
        aria-label="打开题目：${escapeHtml(headline)}"
      >
        <div class="question-card-content">
          <div class="question-card-topline">
            <div class="question-category">${escapeHtml(item.category)}</div>
            <span class="difficulty-badge difficulty-${item.difficulty}">
              ${difficulty[item.difficulty] || "中等"}
            </span>
          </div>

          <h3 class="question-title">${escapeHtml(headline)}</h3>
          ${preview ? `<p class="question-preview">${escapeHtml(preview)}</p>` : ""}

          <div class="question-list-meta">
            <span>${app ? `${escapeHtml(app.company)} · ${escapeHtml(app.role)}` : "通用题库"}</span>
            ${item.stage ? `<span>${escapeHtml(item.stage)}</span>` : ""}
            <span>${followups} 层追问</span>
            <span>${item.answer ? "有参考答案" : "待补答案"}</span>
            ${item.reflection ? `<span>已复盘</span>` : ""}
          </div>

          ${tags.length ? `
            <div class="question-tags question-card-tags">
              ${tags.map(tag => `<span class="question-tag">${escapeHtml(tag)}</span>`).join("")}
              ${item.tags.length > tags.length ? `<span class="question-tag">+${item.tags.length - tags.length}</span>` : ""}
            </div>` : ""}
        </div>

        <div class="question-card-open">
          <span>查看详情</span>
          <strong>→</strong>
        </div>
      </article>`;
  }).join("");

  $("#questionGrid")
    .querySelectorAll("[data-question-id]")
    .forEach(card => {
      const open = () => openQuestionDetail(card.dataset.questionId);
      card.addEventListener("click", open);
      card.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
}

function openQuestionDetail(id) {
  const item = data.questions.find(question => question.id === id);
  if (!item) return;

  activeQuestionDetailId = id;
  questionDetailEditMode = false;
  renderQuestionDetail();
  openModal("questionDetailModal");
}

function refreshQuestionDetailIfOpen() {
  const modal = $("#questionDetailModal");
  if (!modal?.classList.contains("show") || !activeQuestionDetailId) return;

  const exists = data.questions.some(item => item.id === activeQuestionDetailId);
  if (!exists) {
    closeModal("questionDetailModal");
    activeQuestionDetailId = null;
    questionDetailEditMode = false;
    return;
  }

  // 正在编辑时，周期性同步/其它 renderAll 不覆盖尚未保存的输入。
  if (!questionDetailEditMode) renderQuestionDetail();
}

function renderQuestionDetail() {
  const item = data.questions.find(question => question.id === activeQuestionDetailId);
  if (!item) return;

  const app = getApplicationById(item.companyApplicationId);
  const difficulty = { easy: "基础", medium: "中等", hard: "困难" };
  const headline = getQuestionHeadline(item.text);
  const sourceUrl = safeExternalUrl(item.sourceUrl);

  $("#questionDetailEyebrow").textContent = item.category || "面试题";
  $("#questionDetailTitle").textContent = headline;
  $("#questionDetailHeaderMeta").innerHTML = `
    <span class="difficulty-badge difficulty-${item.difficulty}">
      ${difficulty[item.difficulty] || "中等"}
    </span>
    <span>${app ? `${escapeHtml(app.company)} · ${escapeHtml(app.role)}` : "通用题库"}</span>
    ${item.stage ? `<span>${escapeHtml(item.stage)}</span>` : ""}
    <span>更新于 ${escapeHtml(formatDateTime(item.updatedAt))}</span>
  `;

  $("#questionDetailView").innerHTML = `
    <div class="question-detail-layout">
      <main class="question-detail-main">
        <section class="question-detail-section question-detail-section-prompts">
          <div class="question-detail-section-head">
            <div>
              <span class="question-detail-kicker">QUESTION</span>
              <h3>题目与追问</h3>
            </div>
            <span class="question-depth-badge">${getQuestionFollowupCount(item.text)} 层追问</span>
          </div>
          <div class="question-prompt-stack">
            ${renderQuestionPromptBlocks(item.text)}
          </div>
        </section>

        <section class="question-detail-section">
          <div class="question-detail-section-head">
            <div>
              <span class="question-detail-kicker">ANSWER</span>
              <h3>参考答案 / 回答思路</h3>
            </div>
          </div>
          ${renderQuestionTextContent(item.answer, "这道题暂时还没有参考答案。")}
        </section>

        <section class="question-detail-section reflection-section">
          <div class="question-detail-section-head">
            <div>
              <span class="question-detail-kicker">REVIEW</span>
              <h3>我的复盘</h3>
            </div>
          </div>
          ${renderQuestionTextContent(item.reflection, "还没有复盘。面试后可以在这里记录自己的回答、遗漏点和下一次改进。")}
        </section>
      </main>

      <aside class="question-detail-sidebar">
        <section class="question-detail-side-card">
          <span class="question-detail-side-label">分类</span>
          <strong>${escapeHtml(item.category || "其他")}</strong>
        </section>

        <section class="question-detail-side-card">
          <span class="question-detail-side-label">来源</span>
          <strong>${app ? `${escapeHtml(app.company)} · ${escapeHtml(app.role)}` : "通用题库"}</strong>
          ${item.stage ? `<small>${escapeHtml(item.stage)}</small>` : ""}
        </section>

        <section class="question-detail-side-card">
          <span class="question-detail-side-label">标签</span>
          ${item.tags.length
            ? `<div class="question-tags">${item.tags.map(tag => `<span class="question-tag">${escapeHtml(tag)}</span>`).join("")}</div>`
            : `<small>暂无标签</small>`}
        </section>

        ${(item.sourceTitle || sourceUrl) ? `
          <section class="question-detail-side-card">
            <span class="question-detail-side-label">延伸参考</span>
            ${item.sourceTitle ? `<strong>${escapeHtml(item.sourceTitle)}</strong>` : ""}
            ${sourceUrl ? `<a class="question-source-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">打开参考资料 ↗</a>` : ""}
          </section>` : ""}

        <section class="question-detail-side-card question-detail-tip">
          <span class="question-detail-side-label">复习建议</span>
          <small>先口头回答主问题，再连续回答追问。最后再展开参考答案进行对照。</small>
        </section>
      </aside>
    </div>
  `;

  if (!questionDetailEditMode) {
    $("#questionDetailView").classList.remove("hidden");
    $("#questionDetailEditForm").classList.add("hidden");
    $("#questionDetailViewFooter").classList.remove("hidden");
    $("#questionDetailEditFooter").classList.add("hidden");
  }
}

function populateQuestionDetailEditForm(item) {
  $("#questionDetailCategory").innerHTML =
    QUESTION_CATEGORIES
      .map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
      .join("");

  $("#questionDetailCompany").innerHTML =
    `<option value="">通用题库</option>` +
    sortByUpdatedAt(data.applications)
      .map(app => `<option value="${escapeHtml(app.id)}">${escapeHtml(app.company)} · ${escapeHtml(app.role)}</option>`)
      .join("");

  $("#questionDetailCategory").value = item.category;
  $("#questionDetailDifficulty").value = item.difficulty;
  $("#questionDetailCompany").value = data.applications.some(app => app.id === item.companyApplicationId)
    ? item.companyApplicationId
    : "";
  $("#questionDetailStage").value = item.stage || "";
  $("#questionDetailTextInput").value = item.text || "";
  $("#questionDetailAnswerInput").value = item.answer || "";
  $("#questionDetailReflectionInput").value = item.reflection || "";
  $("#questionDetailTagsInput").value = item.tags.join(", ");
  $("#questionDetailSourceTitleInput").value = item.sourceTitle || "";
  $("#questionDetailSourceUrlInput").value = item.sourceUrl || "";
}

function setQuestionDetailEditMode(editing) {
  const item = data.questions.find(question => question.id === activeQuestionDetailId);
  if (!item) return;

  questionDetailEditMode = Boolean(editing);

  if (questionDetailEditMode) {
    populateQuestionDetailEditForm(item);
    $("#questionDetailView").classList.add("hidden");
    $("#questionDetailEditForm").classList.remove("hidden");
    $("#questionDetailViewFooter").classList.add("hidden");
    $("#questionDetailEditFooter").classList.remove("hidden");
    requestAnimationFrame(() => $("#questionDetailTextInput").focus());
  } else {
    $("#questionDetailEditForm").classList.add("hidden");
    $("#questionDetailView").classList.remove("hidden");
    $("#questionDetailEditFooter").classList.add("hidden");
    $("#questionDetailViewFooter").classList.remove("hidden");
    renderQuestionDetail();
  }
}

function saveQuestionDetailEdits() {
  if (!$("#questionDetailEditForm").reportValidity()) return;

  const index = data.questions.findIndex(item => item.id === activeQuestionDetailId);
  if (index < 0) return;

  data.questions[index] = {
    ...data.questions[index],
    category: $("#questionDetailCategory").value,
    difficulty: $("#questionDetailDifficulty").value,
    companyApplicationId: $("#questionDetailCompany").value,
    stage: $("#questionDetailStage").value.trim(),
    text: $("#questionDetailTextInput").value.trim(),
    answer: $("#questionDetailAnswerInput").value.trim(),
    reflection: $("#questionDetailReflectionInput").value.trim(),
    tags: $("#questionDetailTagsInput").value
      .split(/[,，]/)
      .map(tag => tag.trim())
      .filter(Boolean),
    sourceTitle: $("#questionDetailSourceTitleInput").value.trim(),
    sourceUrl: $("#questionDetailSourceUrlInput").value.trim(),
    updatedAt: new Date().toISOString()
  };

  questionDetailEditMode = false;
  saveData();
  renderQuestionDetail();
  showToast("题目已保存并准备云同步");
}

function deleteQuestionFromDetail() {
  const item = data.questions.find(question => question.id === activeQuestionDetailId);
  if (!item) return;

  if (!confirm(`确定删除“${getQuestionHeadline(item.text)}”吗？`)) return;

  data.questions = data.questions.filter(question => question.id !== activeQuestionDetailId);
  activeQuestionDetailId = null;
  questionDetailEditMode = false;
  closeModal("questionDetailModal");
  saveData();
  showToast("题目已删除");
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

function mergeQuestionBankQuestions(rawQuestions, label = "题库") {
  if (!Array.isArray(rawQuestions)) {
    throw new Error("题库 JSON 中没有 questions 数组");
  }

  const existingIds = new Set(data.questions.map(item => item.id));
  const existingText = new Set(
    data.questions.map(item =>
      `${item.category}::${String(item.text || "").trim().toLowerCase()}`
    )
  );

  let added = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const raw of rawQuestions) {
    const item = normalizeQuestion(raw);
    const key = `${item.category}::${String(item.text || "").trim().toLowerCase()}`;

    if (!item.text.trim() || existingIds.has(item.id) || existingText.has(key)) {
      skipped += 1;
      continue;
    }

    item.companyApplicationId = "";
    item.updatedAt = now;

    data.questions.push(item);
    existingIds.add(item.id);
    existingText.add(key);
    added += 1;
  }

  if (added) saveData();
  else {
    renderQuestionModules();
    renderQuestions();
  }

  showToast(`${label}：新增 ${added} 题，跳过 ${skipped} 题`);
  return { added, skipped };
}

async function importBuiltinQuestionBank() {
  try {
    const response = await fetch("./data/robotics-question-bank.json", {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const parsed = await response.json();
    const list = Array.isArray(parsed) ? parsed : parsed.questions;
    mergeQuestionBankQuestions(list, parsed.name || "机器人面试题库");
  } catch (error) {
    alert(
      `导入内置机器人题库失败：${error.message}\n\n` +
      "如果你是直接双击 index.html 本地打开，请部署到 GitHub Pages 后再试；" +
      "也可以点击“导入题库 JSON”手动选择 data/robotics-question-bank.json。"
    );
  }
}

async function importQuestionBankJson(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const parsed = JSON.parse(await file.text());
    const list = Array.isArray(parsed) ? parsed : parsed.questions;
    mergeQuestionBankQuestions(list, parsed.name || file.name);
  } catch (error) {
    alert(`导入题库失败：${error.message}`);
  } finally {
    event.target.value = "";
  }
}


/* ========== V3.3 简历管理 ========== */

function getResumeById(id) {
  return data.resumes.find(item => item.id === id);
}

function ensureActiveResume() {
  const sorted = sortByUpdatedAt(data.resumes);

  if (!sorted.length) {
    activeResumeId = null;
    return null;
  }

  if (!activeResumeId || !getResumeById(activeResumeId)) {
    activeResumeId = sorted[0].id;
  }

  return getResumeById(activeResumeId);
}

function renderResumeList() {
  const rows = sortByUpdatedAt(data.resumes);
  const active = ensureActiveResume();

  $("#resumeCount").textContent = `${rows.length} 份`;

  $("#resumeList").innerHTML = rows.length
    ? rows.map(item => `
        <button
          type="button"
          class="resume-list-item ${active?.id === item.id ? "active" : ""}"
          data-resume-id="${escapeHtml(item.id)}"
        >
          <span class="resume-file-icon">${item.kind === "pdf" ? "PDF" : "DOCX"}</span>
          <span class="resume-list-copy">
            <strong>${escapeHtml(item.name || item.fileName || "未命名简历")}</strong>
            <small>${escapeHtml(formatFileSize(item.fileSize))} · ${item.pageCount || item.previewPaths.length || 0} 页</small>
          </span>
        </button>
      `).join("")
    : `<div class="resume-list-empty">暂无简历</div>`;
}

async function renderResume() {
  renderResumeList();

  const item = ensureActiveResume();
  const empty = $("#resumeEmpty");
  const viewer = $("#resumeViewer");
  const pages = $("#resumePreviewPages");

  if (!item) {
    resumePreviewRenderToken += 1;
    empty.classList.remove("hidden");
    viewer.classList.add("hidden");
    pages.innerHTML = "";
    return;
  }

  empty.classList.add("hidden");
  viewer.classList.remove("hidden");
  $("#resumeViewerName").textContent = item.name || item.fileName || "未命名简历";
  $("#resumeViewerMeta").textContent =
    `${item.kind === "pdf" ? "PDF" : "Word"} · ` +
    `${item.pageCount || item.previewPaths.length || 0} 页 · ` +
    `${formatFileSize(item.fileSize)} · 更新于 ${formatDateTime(item.updatedAt)}`;

  const token = ++resumePreviewRenderToken;

  if (!item.previewPaths.length) {
    pages.innerHTML = `
      <div class="resume-preview-message">
        这份简历没有可用的图片预览，请删除后重新上传。
      </div>`;
    return;
  }

  pages.innerHTML = `<div class="resume-preview-message">正在加载图片预览…</div>`;

  try {
    const { data: signedItems, error } = await supabase
      .storage
      .from(RESUME_BUCKET)
      .createSignedUrls(item.previewPaths, 3600);

    if (error) throw error;
    if (token !== resumePreviewRenderToken) return;

    const urls = (signedItems || []).map(row => row?.signedUrl || "").filter(Boolean);

    if (urls.length !== item.previewPaths.length) {
      throw new Error("部分预览图未能取得访问地址");
    }

    pages.innerHTML = urls.map((url, index) => `
      <figure class="resume-page">
        <img
          src="${escapeHtml(url)}"
          alt="${escapeHtml(item.name || item.fileName || "简历")} 第 ${index + 1} 页"
          loading="${index === 0 ? "eager" : "lazy"}"
        />
        <figcaption>第 ${index + 1} / ${urls.length} 页</figcaption>
      </figure>
    `).join("");
  } catch (error) {
    if (token !== resumePreviewRenderToken) return;

    console.error("加载简历预览失败：", error);
    pages.innerHTML = `
      <div class="resume-preview-message resume-preview-error">
        图片预览加载失败：${escapeHtml(error?.message || "未知错误")}
      </div>`;
  }
}

function setResumeUploadStatus(message = "", type = "") {
  const box = $("#resumeUploadStatus");

  if (!message) {
    box.className = "resume-upload-status hidden";
    box.textContent = "";
    return;
  }

  box.className = `resume-upload-status ${type}`.trim();
  box.textContent = message;
}

function formatFileSize(bytes) {
  const value = Number(bytes) || 0;

  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function getResumeFileKind(file) {
  const name = String(file?.name || "").toLowerCase();

  if (name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".docx")) return "docx";
  if (name.endsWith(".doc")) return "doc";

  return "";
}

function getResumeContentType(kind) {
  if (kind === "pdf") return "application/pdf";
  return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

async function handleResumeUpload(event) {
  const file = event.target.files?.[0];
  event.target.value = "";

  if (!file || !currentUser || !supabase) return;

  const kind = getResumeFileKind(file);

  if (kind === "doc") {
    alert("旧版 .doc 暂时无法在纯浏览器中稳定转成图片。请在 Word 中“另存为 .docx”或导出为 PDF 后再上传。");
    return;
  }

  if (!["pdf", "docx"].includes(kind)) {
    alert("请选择 PDF 或 Word（.docx）格式的简历。");
    return;
  }

  if (file.size > RESUME_MAX_FILE_BYTES) {
    alert(`简历文件不能超过 ${formatFileSize(RESUME_MAX_FILE_BYTES)}。`);
    return;
  }

  const uploadButton = $("#uploadResumeBtn");
  const uploadedPaths = [];
  uploadButton.disabled = true;

  try {
    setResumeUploadStatus("正在把简历转换成逐页图片，请稍候…");

    const previewBlobs = kind === "pdf"
      ? await renderPdfPreviewBlobs(file)
      : await renderDocxPreviewBlobs(file);

    if (!previewBlobs.length) {
      throw new Error("没有生成任何预览页面");
    }

    if (previewBlobs.length > RESUME_MAX_PAGES) {
      throw new Error(`简历最多支持 ${RESUME_MAX_PAGES} 页`);
    }

    const id = createId("resume");
    const originalPath = `${currentUser.id}/${id}/original.${kind}`;
    const previewPaths = previewBlobs.map(
      (_, index) => `${currentUser.id}/${id}/preview-${String(index + 1).padStart(3, "0")}.jpg`
    );

    setResumeUploadStatus(`图片预览已生成，共 ${previewBlobs.length} 页，正在上传到私有云存储…`);

    await uploadResumeObject(originalPath, file, getResumeContentType(kind));
    uploadedPaths.push(originalPath);

    for (let index = 0; index < previewBlobs.length; index += 1) {
      await uploadResumeObject(previewPaths[index], previewBlobs[index], "image/jpeg");
      uploadedPaths.push(previewPaths[index]);
      setResumeUploadStatus(`正在上传预览图 ${index + 1} / ${previewBlobs.length}…`);
    }

    const now = new Date().toISOString();
    const displayName = file.name.replace(/\.(pdf|docx)$/i, "");

    data.resumes.unshift({
      id,
      name: displayName || file.name,
      fileName: file.name,
      kind,
      fileSize: file.size,
      pageCount: previewBlobs.length,
      originalPath,
      previewPaths,
      createdAt: now,
      updatedAt: now
    });

    activeResumeId = id;
    saveData();
    setResumeUploadStatus("简历已上传，图片预览已生成。", "success");
    switchView("resume");
    await renderResume();

    setTimeout(() => setResumeUploadStatus(), 2200);
  } catch (error) {
    console.error("上传简历失败：", error);

    if (uploadedPaths.length) {
      const { error: cleanupError } = await supabase
        .storage
        .from(RESUME_BUCKET)
        .remove(uploadedPaths);

      if (cleanupError) {
        console.warn("清理未完成的简历文件失败：", cleanupError);
      }
    }

    const message = String(error?.message || "未知错误");
    const storageHint = /bucket|row-level|policy|storage|permission|not found/i.test(message)
      ? " 请确认已经在 Supabase SQL Editor 执行更新包里的 supabase-resume-storage.sql。"
      : "";

    setResumeUploadStatus(`上传失败：${message}${storageHint}`, "error");
  } finally {
    uploadButton.disabled = false;
    $("#resumeDocxRenderStage").innerHTML = "";
  }
}

async function uploadResumeObject(path, body, contentType) {
  const { error } = await supabase
    .storage
    .from(RESUME_BUCKET)
    .upload(path, body, {
      cacheControl: "3600",
      contentType,
      upsert: false
    });

  if (error) throw error;
}

let pdfjsLoader = null;

async function loadPdfJs() {
  if (!pdfjsLoader) {
    pdfjsLoader = import(PDFJS_MODULE_URL)
      .then(module => {
        module.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        return module;
      })
      .catch(error => {
        pdfjsLoader = null;
        throw error;
      });
  }

  return pdfjsLoader;
}

async function renderPdfPreviewBlobs(file) {
  const pdfjsLib = await loadPdfJs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  const pdf = await loadingTask.promise;

  try {
    if (pdf.numPages > RESUME_MAX_PAGES) {
      throw new Error(`简历最多支持 ${RESUME_MAX_PAGES} 页`);
    }

    const blobs = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      setResumeUploadStatus(`正在生成 PDF 图片预览 ${pageNumber} / ${pdf.numPages}…`);

      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(2.5, Math.max(1.4, 1400 / baseViewport.width));
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: context, viewport }).promise;

      blobs.push(await canvasToJpegBlob(canvas));
      page.cleanup();
    }

    return blobs;
  } finally {
    await pdf.destroy();
  }
}

async function renderDocxPreviewBlobs(file) {
  if (!window.docx?.renderAsync) {
    throw new Error("Word 预览组件加载失败，请刷新页面后重试");
  }

  if (typeof window.html2canvas !== "function") {
    throw new Error("图片转换组件加载失败，请刷新页面后重试");
  }

  const stage = $("#resumeDocxRenderStage");
  stage.innerHTML = "";

  setResumeUploadStatus("正在解析 Word 文档…");

  await window.docx.renderAsync(file, stage, null, {
    inWrapper: true,
    breakPages: true,
    ignoreWidth: false,
    ignoreHeight: false,
    ignoreFonts: false,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    useBase64URL: true,
    ignoreLastRenderedPageBreak: false
  });

  if (document.fonts?.ready) {
    await document.fonts.ready;
  }

  await waitForImages(stage);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  let pages = [...stage.querySelectorAll(".docx-wrapper > section.docx")];

  if (!pages.length) pages = [...stage.querySelectorAll("section.docx")];

  if (!pages.length) {
    const wrapper = stage.querySelector(".docx-wrapper");
    if (wrapper) pages = [wrapper];
  }

  if (!pages.length) {
    throw new Error("Word 文档解析完成，但没有识别到可预览页面");
  }

  if (pages.length > RESUME_MAX_PAGES) {
    throw new Error(`简历最多支持 ${RESUME_MAX_PAGES} 页`);
  }

  const blobs = [];

  for (let index = 0; index < pages.length; index += 1) {
    setResumeUploadStatus(`正在生成 Word 图片预览 ${index + 1} / ${pages.length}…`);

    const canvas = await window.html2canvas(pages[index], {
      backgroundColor: "#ffffff",
      scale: Math.min(2, Math.max(1.35, window.devicePixelRatio || 1)),
      useCORS: true,
      logging: false
    });

    blobs.push(await canvasToJpegBlob(canvas));
  }

  stage.innerHTML = "";
  return blobs;
}

function waitForImages(container) {
  const images = [...container.querySelectorAll("img")];

  return Promise.all(
    images.map(image => {
      if (image.complete) return Promise.resolve();

      return new Promise(resolve => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      });
    })
  );
}

function canvasToJpegBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("图片预览生成失败")),
      "image/jpeg",
      0.92
    );
  });
}

async function downloadActiveResume() {
  const item = getResumeById(activeResumeId);
  if (!item) return;

  try {
    const { data: blob, error } = await supabase
      .storage
      .from(RESUME_BUCKET)
      .download(item.originalPath);

    if (error) throw error;

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = item.fileName || `${item.name}.${item.kind}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    alert(`下载简历失败：${error?.message || "未知错误"}`);
  }
}

async function deleteActiveResume() {
  const item = getResumeById(activeResumeId);
  if (!item) return;

  if (!confirm(`确定删除简历「${item.name || item.fileName}」吗？原文件和图片预览都会从云端删除。`)) {
    return;
  }

  const paths = [item.originalPath, ...item.previewPaths].filter(Boolean);

  try {
    if (paths.length) {
      const { error } = await supabase
        .storage
        .from(RESUME_BUCKET)
        .remove(paths);

      if (error) throw error;
    }

    data.resumes = data.resumes.filter(row => row.id !== item.id);
    activeResumeId = null;
    saveData();
    showToast("简历已删除");
    await renderResume();
  } catch (error) {
    alert(`删除简历失败：${error?.message || "未知错误"}`);
  }
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
