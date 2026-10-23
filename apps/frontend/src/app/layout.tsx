import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";
import { Shell } from "@/components/shell";
export const metadata:Metadata={title:"Steppe Sentinel",description:"Спутниковый мониторинг пастбищ по данным Sentinel-2"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ru"><body><Providers><Shell>{children}</Shell></Providers></body></html>}
