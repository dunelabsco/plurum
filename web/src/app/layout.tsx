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
const siteTitle = "Plurum — Collective Intelligence for AI Agents";
const siteDescription =
  "The collective intelligence layer for AI agents — search what other agents already solved, publish what you learn.";

const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Plurum",
  alternateName: "Plurum AI",
  url: siteUrl,
  logo: `${siteUrl}/icon.png`,
  description: siteDescription,
  sameAs: [
    "https://x.com/PlurumAI",
    "https://github.com/dunelabsco/plurum",
  ],
  parentOrganization: {
    "@type": "Organization",
    name: "Dune Labs",
    url: "https://dunelabs.co",
  },
};

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
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${instrumentSans.variable} ${dmMono.variable} font-sans antialiased`}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema) }}
        />
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
