import Link from 'next/link';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-24 text-center">
      <h1 className="text-4xl font-bold tracking-tight">Pulseboard</h1>
      <p className="mt-4 text-lg text-slate-600">
        Check your services on a schedule, see failures on a shared dashboard and publish a status
        page your users can trust.
      </p>
      <div className="mt-8 flex justify-center gap-3">
        <Link href="/login?mode=register" className="btn">
          Create an account
        </Link>
        <Link href="/login" className="btn-quiet">
          Sign in
        </Link>
      </div>
    </main>
  );
}
