import {
  Activity,
  Anvil,
  Bell,
  Blocks,
  BookOpen,
  Bot,
  Clapperboard,
  Container,
  DatabaseBackup,
  FolderKanban,
  HardDrive,
  House,
  ListChecks,
  ListTodo,
  LockKeyhole,
  MessageCircle,
  MonitorSmartphone,
  Network,
  ScrollText,
  Server,
  ServerCog,
  Settings2,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

/** Phones: four places in the bottom bar (asking comes first after Home), the rest behind More. */
export const mobilePrimaryNav: NavItem[] = [
  { to: "/", label: "Home", icon: House },
  { to: "/ask", label: "Ask", icon: MessageCircle },
  { to: "/projects", label: "Projects", icon: FolderKanban },
  { to: "/services", label: "Systems", icon: Server },
];

export const moreNav: NavItem[] = [
  { to: "/todo", label: "To-do", icon: ListTodo },
  { to: "/releases", label: "Releases", icon: Clapperboard },
  { to: "/forge", label: "The Forge", icon: Anvil },
  { to: "/incidents", label: "Monitoring", icon: Activity },
  { to: "/jobs", label: "Jobs", icon: ListChecks },
  { to: "/vault", label: "Secure Vault", icon: LockKeyhole },
  { to: "/agent", label: "Agents", icon: Bot },
  { to: "/docker", label: "Docker", icon: Container },
  { to: "/systems", label: "Machines", icon: ServerCog },
  { to: "/backups", label: "Backups", icon: DatabaseBackup },
  { to: "/network", label: "Network", icon: Network },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/memory", label: "Memory", icon: BookOpen },
  { to: "/storage", label: "Storage", icon: HardDrive },
  { to: "/autonomy", label: "Autonomy", icon: SlidersHorizontal },
  { to: "/notifications", label: "Notifications", icon: Bell },
  { to: "/devices", label: "PCs and devices", icon: MonitorSmartphone },
  { to: "/integrations", label: "Integrations", icon: Blocks },
  { to: "/settings", label: "Settings", icon: Settings2 },
];
