import AppShell from "./AppShell";

export default function HomePage() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || "http://127.0.0.1:3001";
  return <AppShell apiUrl={apiUrl} />;
}
