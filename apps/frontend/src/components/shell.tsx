"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartNoAxesCombined, ChevronLeft, CircleHelp, FileChartColumn, LayoutDashboard, LockKeyhole, LogIn, LogOut, Map, Menu, Orbit, Settings, Sparkles, UserPlus, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { type Language, useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { Button, Input } from "@/components/ui";

const navigation = [
  { href: "/", label: "Обзор", icon: LayoutDashboard },
  { href: "/map", label: "Карта и пастбища", icon: Map },
  { href: "/satellite", label: "Спутниковые данные", icon: Orbit },
  { href: "/ndvi", label: "NDVI и NDMI", icon: ChartNoAxesCombined },
  { href: "/conclusion", label: "ML-заключение", icon: Sparkles },
  { href: "/reports", label: "Отчёты", icon: FileChartColumn },
  { href: "/settings", label: "Настройки", icon: Settings }
];

const languageLabels: Record<Language, string> = { ru: "RU", kk: "KZ", en: "EN" };

function LanguageSwitch() {
  const { language, setLanguage, t } = useI18n();
  return <div className="flex shrink-0 items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5" role="group" aria-label={t("Язык интерфейса")}>
    {(Object.keys(languageLabels) as Language[]).map((item) => <button
      key={item}
      type="button"
      onClick={() => setLanguage(item)}
      aria-pressed={language === item}
      className={cn("min-h-8 min-w-8 rounded-md px-1.5 text-[10px] font-bold transition", language === item ? "bg-white text-emerald-800 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:text-slate-800")}
    >{languageLabels[item]}</button>)}
  </div>;
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const demo = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
  const { t } = useI18n();
  const { user, loading, logout } = useAuth();

  useEffect(() => setOpen(false), [path]);

  if (loading) return <div className="grid min-h-screen place-items-center bg-[#f5f7f5]"><div className="text-center"><Image src="/steppe-sentinel-logo.png" alt="Steppe Sentinel" width={2172} height={724} priority className="mx-auto h-auto w-56" /><div className="mx-auto mt-5 size-7 animate-spin rounded-full border-2 border-emerald-700 border-t-transparent" /><p className="mt-3 text-xs text-slate-500">{t("Проверка сессии…")}</p></div></div>;
  if (!user) return <AuthScreen />;
  const visibleNavigation = user.role === "ADMIN" ? [...navigation, { href: "/admin/users", label: "Пользователи", icon: Users }] : navigation;
  const initials = user.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "SS";

  return <div className="min-h-screen bg-[#f5f7f5] text-slate-900">
    {open && <button aria-label={t("Закрыть меню")} className="fixed inset-0 z-40 bg-slate-950/35 backdrop-blur-[1px] lg:hidden" onClick={() => setOpen(false)} />}
    <aside className={cn("fixed inset-y-0 left-0 z-50 flex w-[min(86vw,17rem)] flex-col border-r border-slate-200 bg-[#fbfcfa] shadow-2xl transition-transform lg:w-60 lg:translate-x-0 lg:shadow-none", open ? "translate-x-0" : "-translate-x-full")}>
      <div className="flex h-20 items-center border-b border-slate-200 px-4">
        <Link href="/" className="min-w-0 flex-1" aria-label="Steppe Sentinel">
          <Image src="/steppe-sentinel-logo.png" alt="Steppe Sentinel" width={2172} height={724} priority className="h-auto w-[205px] max-w-full object-contain object-left" />
        </Link>
        <button className="ml-2 grid size-10 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 lg:hidden" aria-label={t("Закрыть меню")} onClick={() => setOpen(false)}><ChevronLeft size={19} /></button>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {visibleNavigation.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? path === href : path.startsWith(href);
          return <Link key={href} href={href} className={cn("flex min-h-11 items-center gap-3 rounded-lg px-3 text-[13px] font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900", active && "bg-emerald-50 text-emerald-900 shadow-[inset_3px_0_0_var(--brand-gold)]")}><Icon size={17} />{t(label)}</Link>;
        })}
      </nav>
      <div className="m-3 rounded-xl border border-emerald-100 bg-emerald-50/70 p-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-emerald-900"><CircleHelp size={15} />{t("Научная оговорка")}</div>
        <p className="mt-2 text-[10px] leading-4 text-emerald-950/65">{t("ML-заключение описывает спектральное состояние покрова и не является прямой мерой кормовой продуктивности.")}</p>
      </div>
      <div className="mx-3 mb-3 flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-2.5">
        <div className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--brand-green)] text-[10px] font-bold text-[#f6c344]">{initials}</div>
        <div className="min-w-0 flex-1"><p className="truncate text-xs font-bold text-slate-800">{user.name}</p><p className="truncate text-[9px] text-slate-500">{t(user.role === "ADMIN" ? "Администратор" : "Клиент")}</p></div>
        <button type="button" onClick={() => void logout()} title={t("Выйти")} aria-label={t("Выйти")} className="grid size-9 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600"><LogOut size={16} /></button>
      </div>
    </aside>
    <div className="lg:pl-60">
      <header className="sticky top-0 z-40 flex min-h-16 items-center border-b border-slate-200 bg-white/95 px-3 py-2 backdrop-blur sm:px-4 lg:px-6">
        <button className="mr-2 grid size-10 shrink-0 place-items-center rounded-lg text-slate-700 hover:bg-slate-100 lg:hidden" aria-label={t("Открыть меню")} onClick={() => setOpen(true)}><Menu size={21} /></button>
        <Image src="/steppe-sentinel-logo.png" alt="Steppe Sentinel" width={2172} height={724} priority className="h-auto w-[124px] shrink-0 object-contain object-left sm:w-[150px] lg:hidden" />
        <div className="hidden min-w-0 lg:block">
          <p className="text-sm font-semibold">{t("Мониторинг пастбищ")}</p>
          <p className="truncate text-[11px] text-slate-500">{t("Северо-Казахстанская область · Sentinel-2 L2A")}</p>
        </div>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <span className={cn("hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 xl:flex", demo ? "bg-amber-50 text-amber-700 ring-amber-600/20" : "bg-emerald-50 text-emerald-700 ring-emerald-600/20")}><span className={cn("size-1.5 rounded-full", demo ? "bg-amber-500" : "bg-emerald-500")} />{demo ? t("Demo Mode · синтетические данные") : t("Sentinel-2 · реальные данные")}</span>
          <LanguageSwitch />
          <div className="hidden size-8 place-items-center rounded-full bg-[var(--brand-green)] text-[10px] font-bold text-[#f6c344] sm:grid" title={user.name}>{initials}</div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  </div>;
}

function AuthScreen() {
  const { t, translateRuntime } = useI18n();
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (mode === "login") await login(email, password);
      else await register(name, email, password);
    } catch (reason) { setError(reason instanceof Error ? translateRuntime(reason.message) : t("Не удалось выполнить операцию")); }
    finally { setPending(false); }
  };

  return <div className="relative min-h-screen overflow-hidden bg-[#f4f7f3] px-4 py-8 sm:grid sm:place-items-center">
    <div className="pointer-events-none absolute -left-32 top-1/3 size-80 rounded-full bg-emerald-200/30 blur-3xl" />
    <div className="pointer-events-none absolute -right-24 top-0 size-72 rounded-full bg-amber-200/30 blur-3xl" />
    <div className="relative mx-auto w-full max-w-md">
      <div className="mb-5 flex items-center justify-between gap-4"><Image src="/steppe-sentinel-logo.png" alt="Steppe Sentinel" width={2172} height={724} priority className="h-auto w-56 max-w-[70%]" /><LanguageSwitch /></div>
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xl shadow-slate-900/5 sm:p-7">
        <div className="mb-6 flex rounded-xl bg-slate-100 p-1">
          <button type="button" onClick={() => { setMode("login"); setError(null); }} className={cn("flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg text-xs font-bold transition", mode === "login" ? "bg-white text-emerald-800 shadow-sm" : "text-slate-500")}><LogIn size={15} />{t("Вход")}</button>
          <button type="button" onClick={() => { setMode("register"); setError(null); }} className={cn("flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg text-xs font-bold transition", mode === "register" ? "bg-white text-emerald-800 shadow-sm" : "text-slate-500")}><UserPlus size={15} />{t("Регистрация")}</button>
        </div>
        <div className="mb-5"><div className="grid size-10 place-items-center rounded-xl bg-emerald-50 text-emerald-800"><LockKeyhole size={19} /></div><h1 className="mt-3 text-xl font-bold">{mode === "login" ? t("Войти в Steppe Sentinel") : t("Создать учётную запись")}</h1><p className="mt-1 text-xs leading-5 text-slate-500">{mode === "login" ? t("Введите данные своей учётной записи.") : t("Новая учётная запись создаётся с ролью клиента.")}</p></div>
        <form className="space-y-4" onSubmit={submit}>
          {mode === "register" && <label className="block"><span className="mb-1.5 block text-[11px] font-bold text-slate-600">{t("Имя")}</span><Input autoComplete="name" required minLength={2} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder={t("Ваше имя")} /></label>}
          <label className="block"><span className="mb-1.5 block text-[11px] font-bold text-slate-600">Email</span><Input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></label>
          <label className="block"><span className="mb-1.5 block text-[11px] font-bold text-slate-600">{t("Пароль")}</span><Input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "register" ? 10 : 1} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "register" ? t("Минимум 10 символов, буква и цифра") : "••••••••••"} /></label>
          {error && <div role="alert" className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">{error}</div>}
          <Button className="h-11 w-full bg-[var(--brand-green)] hover:bg-emerald-950" type="submit" disabled={pending}>{pending ? t("Подождите…") : mode === "login" ? t("Войти") : t("Зарегистрироваться")}</Button>
        </form>
      </div>
      <p className="mt-4 text-center text-[10px] leading-4 text-slate-400">{t("Защищённая сессия · пароль не хранится в открытом виде")}</p>
    </div>
  </div>;
}
