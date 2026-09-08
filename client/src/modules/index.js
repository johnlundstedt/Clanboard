import { Home, ListChecks, ShoppingCart, Utensils, Calendar, Settings } from "lucide-react";
import DashboardPage from "./dashboard/DashboardPage.jsx";
import DashboardAdmin from "./dashboard/DashboardAdmin.jsx";
import TasksPage from "./tasks/TasksPage.jsx";
import ListsPage from "./lists/ListsPage.jsx";
import MealPlanPage from "./mealplan/MealPlanPage.jsx";
import CalendarPage from "./calendar/CalendarPage.jsx";
import CalendarAdmin from "./calendar/CalendarAdmin.jsx";
import AdminPage from "./admin/AdminPage.jsx";

// Each module: { name, navLabel, page, icon, desc, admin? (admin panel), adminOnly?, locked? }
// The enabled/disabled set is controlled by the server (Admin >> Modules).
// `admin` is an optional component rendered inside this module's Admin section.
const modules = [
  {
    name: "dashboard",
    navLabel: "Home",
    page: DashboardPage,
    admin: DashboardAdmin,
    icon: Home,
    default: true,
    locked: true, // Home is the landing view for everyone
    desc: "Weather, household birthdays, and “what needs to be done today”, with quick-add tasks.",
  },
  {
    name: "tasks",
    navLabel: "Tasks",
    page: TasksPage,
    icon: ListChecks,
    desc: "Chores and tasks: due dates, assignments, adult review, and daily/weekly recurrence.",
  },
  {
    name: "lists",
    navLabel: "Lists",
    page: ListsPage,
    icon: ShoppingCart,
    desc: "Shared lists (groceries, to-buy, packing) that everyone checks off in real time.",
  },
  {
    name: "meal-plan",
    navLabel: "Meals",
    page: MealPlanPage,
    icon: Utensils,
    desc: "Weekly board with breakfast, lunch, dinner, and snack per day (free text).",
  },
  {
    name: "calendar",
    navLabel: "Calendar",
    page: CalendarPage,
    admin: CalendarAdmin,
    icon: Calendar,
    desc: "Read-only Google Calendar events, color-coded and synced into the app.",
  },
  {
    name: "admin",
    navLabel: "Admin",
    page: AdminPage,
    icon: Settings,
    adminOnly: true,
    locked: true,
    desc: "Module controls, household members, and settings. Cannot be disabled.",
  },
];

export default modules;

export function getClientModule(name) {
  return modules.find((m) => m.name === name);
}