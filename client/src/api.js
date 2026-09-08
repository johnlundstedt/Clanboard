const BASE = "/api";

async function req(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (res.status === 401) {
    window.dispatchEvent(new Event("fh:unauthorized"));
    throw new Error("Not authenticated");
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

// --- Auth --------------------------------------------------------------------
export const getMe = () => req("/auth/me");
export const login = (name, password) =>
  req("/auth/login", { method: "POST", body: JSON.stringify({ name, password }) });
export const logout = () => req("/auth/logout", { method: "POST" });

// --- Modules / nav -----------------------------------------------------------
export const getModules = () => req("/modules");

// --- Tasks -------------------------------------------------------------------
export const getTasks = (userId) => req(userId ? `/tasks?user_id=${userId}` : "/tasks");
export const getTodayTasks = () => req("/tasks/today");
export const createTask = (task) => req("/tasks", { method: "POST", body: JSON.stringify(task) });
export const quickAddTask = (name, assignedIds) =>
  req("/tasks/quick-add", {
    method: "POST",
    body: JSON.stringify({ name, ...(assignedIds?.length ? { assigned_ids: assignedIds } : {}) }),
  });
export const completeTask = (id) => req(`/tasks/${id}/complete`, { method: "PATCH" });
export const uncompleteTask = (id) => req(`/tasks/${id}/uncomplete`, { method: "PATCH" });
export const reviewTask = (id) => req(`/tasks/${id}/review`, { method: "PATCH" });
export const unreviewTask = (id) => req(`/tasks/${id}/unreview`, { method: "PATCH" });
export const assignTask = (id, userIds) =>
  req(`/tasks/${id}/assign`, { method: "PATCH", body: JSON.stringify({ user_ids: userIds }) });
export const updateTask = (id, fields) =>
  req(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(fields) });
export const deleteTask = (id) => req(`/tasks/${id}`, { method: "DELETE" });

// --- Lists -------------------------------------------------------------------
export const getLists = () => req("/lists");
export const createList = (name) => req("/lists", { method: "POST", body: JSON.stringify({ name }) });
export const deleteList = (id) => req(`/lists/${id}`, { method: "DELETE" });
export const addListItem = (listId, text) =>
  req(`/lists/${listId}/items`, { method: "POST", body: JSON.stringify({ text }) });
export const toggleListItem = (itemId, checked) =>
  req(`/lists/items/${itemId}`, { method: "PATCH", body: JSON.stringify({ checked }) });
export const deleteListItem = (itemId) => req(`/lists/items/${itemId}`, { method: "DELETE" });

// --- Meal plan ---------------------------------------------------------------
export const getMealWeek = (start) => req(`/meal-plan/week?start=${start}`);
export const setMealEntry = (date, slot, text) =>
  req(`/meal-plan/${date}/${slot}`, { method: "PUT", body: JSON.stringify({ text }) });

// --- Calendar ----------------------------------------------------------------
export const getCalendarEvents = (start, end) =>
  req(`/calendar?start=${encodeURIComponent(start)}${end ? `&end=${encodeURIComponent(end)}` : ""}`);
export const getCalendarConnections = () => req("/calendar/connections");
export const createCalendarConnection = (conn) =>
  req("/calendar/connections", { method: "POST", body: JSON.stringify(conn) });
export const deleteCalendarConnection = (id) => req(`/calendar/connections/${id}`, { method: "DELETE" });
export const syncCalendar = () => req("/calendar/sync", { method: "POST" });

// --- Dashboard ---------------------------------------------------------------
export const getDashboard = (userId) => req(userId ? `/dashboard?user_id=${userId}` : "/dashboard");
export const getDashboardSettings = () => req("/dashboard/settings");
export const setDashboardSettings = (s) =>
  req("/dashboard/settings", { method: "POST", body: JSON.stringify(s) });
export const geocode = (q) => req(`/dashboard/geocode?q=${encodeURIComponent(q)}`);
export const reverseGeocode = (lat, lon) =>
  req(`/dashboard/reverse-geocode?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);

// --- Admin -------------------------------------------------------------------
export const getAdminModules = () => req("/admin/modules");
export const setModuleEnabled = (name, enabled) =>
  req(`/admin/modules/${name}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
export const getAdminSettings = () => req("/admin/settings");
export const setAdminSettings = (s) =>
  req("/admin/settings", { method: "POST", body: JSON.stringify(s) });
export const getRoles = () => req("/admin/roles");
export const getRoleCapabilities = () => req("/admin/role-capabilities");
export const createRole = (role) =>
  req("/admin/roles", { method: "POST", body: JSON.stringify(role) });
export const updateRole = (id, role) =>
  req(`/admin/roles/${id}`, { method: "PATCH", body: JSON.stringify(role) });
export const deleteRole = (id) => req(`/admin/roles/${id}`, { method: "DELETE" });
export const getMembers = () => req("/members");
export const createMember = (member) =>
  req("/admin/members", { method: "POST", body: JSON.stringify(member) });
export const updateMember = (id, fields) =>
  req(`/admin/members/${id}`, { method: "PATCH", body: JSON.stringify(fields) });
export const deleteMember = (id) => req(`/admin/members/${id}`, { method: "DELETE" });
export const getMemberModules = (id) => req(`/admin/members/${id}/modules`);
export const setMemberModule = (id, module, enabled) =>
  req(`/admin/members/${id}/modules`, {
    method: "PATCH",
    body: JSON.stringify({ module, enabled }),
  });
export const uploadPhoto = (data, name) =>
  req("/admin/photos", { method: "POST", body: JSON.stringify({ data, name }) });

// --- Task config (categories / priorities) -----------------------------------
export const getTaskSettings = () => req("/tasks/settings");
export const getTaskCategories = () => req("/tasks/categories");
export const createTaskCategory = (c) =>
  req("/tasks/categories", { method: "POST", body: JSON.stringify(c) });
export const updateTaskCategory = (id, c) =>
  req(`/tasks/categories/${id}`, { method: "PATCH", body: JSON.stringify(c) });
export const deleteTaskCategory = (id) =>
  req(`/tasks/categories/${id}`, { method: "DELETE" });
export const getTaskPriorities = () => req("/tasks/priorities");
export const createTaskPriority = (p) =>
  req("/tasks/priorities", { method: "POST", body: JSON.stringify(p) });
export const updateTaskPriority = (id, p) =>
  req(`/tasks/priorities/${id}`, { method: "PATCH", body: JSON.stringify(p) });
export const deleteTaskPriority = (id) =>
  req(`/tasks/priorities/${id}`, { method: "DELETE" });