"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, ShieldCheck, UserCheck, UserCog, UserRound, UserX, Users } from "lucide-react";
import { useState } from "react";
import { Page } from "./page";
import { Badge, Button, Card, Empty, Input, Select } from "./ui";
import { api } from "@/lib/api";
import { useAuth, type UserRole } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";

interface ManagedUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UsersResponse {
  users: ManagedUser[];
  total: number;
  summary: { total: number; active: number; admins: number; clients: number };
}

export function AdminUsersPage() {
  const { user } = useAuth();
  const { t, formatDate, translateRuntime } = useI18n();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const users = useQuery({ queryKey: ["admin-users", search], queryFn: () => api<UsersResponse>(`/admin/users${search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ""}`), enabled: user?.role === "ADMIN" });
  const update = useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: { role?: UserRole; isActive?: boolean } }) => api(`/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(changes) }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["admin-users"] })
  });

  if (user?.role !== "ADMIN") return <Page title={t("Доступ запрещён")} description={t("Управление пользователями доступно только администратору.")}><Empty title="403" description={t("У вашей учётной записи нет необходимых прав.")} /></Page>;
  const summary = users.data?.summary;

  return <Page
    eyebrow="Role-based access control"
    title={t("Управление пользователями")}
    description={t("Просмотр зарегистрированных пользователей, назначение ролей и управление доступом к системе.")}
    actions={<div className="relative w-full sm:w-72"><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><Input className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("Поиск по имени или email")} /></div>}
  >
    <div className="mb-5 grid gap-3 grid-cols-2 xl:grid-cols-4">
      <Summary icon={Users} label={t("Всего пользователей")} value={summary?.total ?? 0} />
      <Summary icon={UserCheck} label={t("Активные")} value={summary?.active ?? 0} tone="green" />
      <Summary icon={ShieldCheck} label={t("Администраторы")} value={summary?.admins ?? 0} tone="amber" />
      <Summary icon={UserRound} label={t("Клиенты")} value={summary?.clients ?? 0} />
    </div>

    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 sm:px-5"><div><h2 className="text-sm font-bold">{t("Учётные записи")}</h2><p className="mt-0.5 text-[10px] text-slate-500">{t("Роль определяет доступ к административному разделу.")}</p></div><Badge tone="blue">RBAC</Badge></div>
      {users.isLoading ? <div className="p-6 text-center text-xs text-slate-500">{t("Загрузка пользователей…")}</div> : users.data?.users.length ? <div className="overflow-x-auto"><table className="min-w-[780px] w-full text-left"><thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500"><tr><th className="px-5 py-3">{t("Пользователь")}</th><th className="px-4 py-3">{t("Роль")}</th><th className="px-4 py-3">{t("Состояние")}</th><th className="px-4 py-3">{t("Последний вход")}</th><th className="px-4 py-3 text-right">{t("Действия")}</th></tr></thead><tbody className="divide-y divide-slate-100">{users.data.users.map((item) => {
        const isSelf = item.id === user.id;
        return <tr key={item.id} className="text-xs"><td className="px-5 py-3"><div className="flex items-center gap-3"><div className="grid size-9 shrink-0 place-items-center rounded-full bg-slate-100 text-[10px] font-bold text-slate-600">{initials(item.name)}</div><div className="min-w-0"><p className="font-bold text-slate-800">{item.name} {isSelf && <span className="font-normal text-emerald-700">({t("вы")})</span>}</p><p className="mt-0.5 text-[10px] text-slate-500">{item.email}</p><p className="mt-0.5 text-[9px] text-slate-400">{t("Регистрация")}: {formatDate(item.createdAt)}</p></div></div></td><td className="px-4 py-3"><Select className="w-36" value={item.role} disabled={update.isPending} onChange={(event) => update.mutate({ id: item.id, changes: { role: event.target.value as UserRole } })}><option value="CLIENT">{t("Клиент")}</option><option value="ADMIN">{t("Администратор")}</option></Select></td><td className="px-4 py-3"><Badge tone={item.isActive ? "green" : "red"}>{item.isActive ? t("Активен") : t("Заблокирован")}</Badge></td><td className="px-4 py-3 text-slate-500">{item.lastLoginAt ? formatDate(item.lastLoginAt) : t("Ещё не входил")}</td><td className="px-4 py-3 text-right"><Button variant={item.isActive ? "danger" : "secondary"} disabled={update.isPending || isSelf} title={isSelf ? t("Свою учётную запись заблокировать нельзя") : undefined} onClick={() => update.mutate({ id: item.id, changes: { isActive: !item.isActive } })}>{item.isActive ? <UserX size={14} /> : <UserCheck size={14} />}{item.isActive ? t("Заблокировать") : t("Разблокировать")}</Button></td></tr>;
      })}</tbody></table></div> : <div className="p-5"><Empty title={t("Пользователи не найдены")} description={t("Измените строку поиска и попробуйте снова.")} /></div>}
    </Card>
    {update.error && <div className="mt-4 rounded-lg border border-red-100 bg-red-50 p-3 text-xs text-red-700">{translateRuntime(update.error.message)}</div>}
    <Card className="mt-5 border-blue-100 bg-blue-50/60 p-4"><div className="flex gap-3"><UserCog size={18} className="mt-0.5 shrink-0 text-blue-700" /><div><p className="text-xs font-bold text-blue-900">{t("Как работают роли")}</p><p className="mt-1 text-[11px] leading-5 text-blue-800/75">{t("Клиент использует все функции мониторинга. Администратор имеет те же возможности и дополнительно управляет пользователями. Последнего активного администратора нельзя заблокировать или понизить до клиента.")}</p></div></div></Card>
  </Page>;
}

function initials(name: string) { return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
function Summary({ icon: Icon, label, value, tone = "slate" }: { icon: any; label: string; value: number; tone?: "slate" | "green" | "amber" }) { const styles = { slate: "bg-slate-100 text-slate-600", green: "bg-emerald-50 text-emerald-700", amber: "bg-amber-50 text-amber-700" }; return <Card className="p-3 sm:p-4"><div className={`grid size-9 place-items-center rounded-lg ${styles[tone]}`}><Icon size={17} /></div><p className="mt-3 text-xl font-bold">{value}</p><p className="mt-1 text-[10px] text-slate-500">{label}</p></Card>; }
