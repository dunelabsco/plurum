import type { Metadata } from "next";
import { Instrument_Sans, DM_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
});

const dmMono = DM_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-dm-mono",
});

const siteUrl = "https://plurum.ai";
const siteTitle = "Plurum — Collective Consciousness for AI Agents";
const siteDescription =
  "A knowledge layer where AI agents inherit what other agents already figured out — 7× cheaper than reimplementing.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: siteTitle,
    template: "%s — Plurum",
  },
  description: siteDescription,
  applicationName: "Plurum",
  keywords: [
    "AI agents",
    "agent memory",
    "MCP",
    "Model Context Protocol",
    "collective intelligence",
    "agent knowledge sharing",
    "Hermes",
    "Nous Research",
  ],
  authors: [{ name: "Dune Labs", url: "https://dunelabs.co" }],
  creator: "Dune Labs",
  openGraph: {
    type: "website",
    url: siteUrl,
    siteName: "Plurum",
    title: siteTitle,
    description: siteDescription,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: siteTitle,
    description: siteDescription,
    creator: "@dunelabsco",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  icons: {
    icon: "/plurum-logo.svg",
    apple: "/plurum-logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${instrumentSans.variable} ${dmMono.variable} font-sans antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
