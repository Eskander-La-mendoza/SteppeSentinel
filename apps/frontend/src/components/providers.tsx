"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { I18nProvider } from "@/lib/i18n";
import { AuthProvider } from "@/lib/auth";
export function Providers({children}:{children:React.ReactNode}){const [client]=useState(()=>new QueryClient({defaultOptions:{queries:{staleTime:20_000,retry:1,refetchOnWindowFocus:false}}}));return <I18nProvider><QueryClientProvider client={client}><AuthProvider>{children}</AuthProvider></QueryClientProvider></I18nProvider>;}
