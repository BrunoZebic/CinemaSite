import Link from "next/link";

export default function Home() {
  return (
    <main className="landing">
      <section className="landing-card slide-in">
        <p className="landing-kicker">Live Cinema Pilot</p>
        <h1 className="landing-title">Premiere Room Prototype</h1>
        <p className="landing-copy">
          Synchronized premiere night with intentional realtime chat. No login
          wall, no inbox campaign, no friction.
        </p>
        <Link className="landing-link" href="/premiere/demo">
          Enter /premiere/demo
        </Link>
      </section>
    </main>
  );
}
