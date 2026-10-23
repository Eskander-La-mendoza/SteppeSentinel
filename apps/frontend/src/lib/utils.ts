import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export const MONTHS: Record<number,string> = {5:"Май",6:"Июнь",7:"Июль",8:"Август",9:"Сентябрь"};
export const formatNumber = (value: number | null | undefined, digits=2) => value == null ? "—" : new Intl.NumberFormat("ru-RU",{maximumFractionDigits:digits,minimumFractionDigits:digits}).format(value);
export const formatDate = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("ru-RU",{day:"2-digit",month:"short",year:"numeric"}).format(new Date(value)) : "Нет данных";
