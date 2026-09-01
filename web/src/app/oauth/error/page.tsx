import Link from "next/link";

export default function OAuthConnectionErrorPage() {
  return (
    <main className="min-h-svh flex items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-2xl border border-black/[0.06] bg-white/45 p-8 text-center backdrop-blur-sm">
        <Link
          href="/"
          className="font-display text-sm tracking-tight text-[#0A0A0A]"
        >
          plurum
        </Link>
        <h1 className="mt-8 font-display text-xl text-[#0A0A0A]">
          connection not completed
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-black/35">
          no authorization code was sent to the requesting application. return
          to your agent app and try connecting again.
        </p>
      </div>
    </main>
  );
}
