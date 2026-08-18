import { FormEvent, useState } from "react";
import { Building2 } from "lucide-react";
import { ApiError, User, request } from "../lib/api";
import { Button, Notice, Spinner, TextInput } from "./ui";

export function AuthView({
  onAuth,
  message
}: {
  onAuth: (user: User) => void;
  message?: string;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const payload = await request<{ user: User }>(
        mode === "login" ? "/api/auth/login" : "/api/auth/register",
        {
          method: "POST",
          body: mode === "login" ? { email, password } : { name, email, password }
        }
      );
      onAuth(payload.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <section className="grid w-full max-w-5xl overflow-hidden rounded-lg border border-[#dbe2df] bg-white shadow-soft md:grid-cols-[1.05fr_0.95fr]">
        <div className="bg-[#173f3f] p-8 text-white md:p-10">
          <div className="flex h-11 w-11 items-center justify-center rounded-md bg-white/12">
            <Building2 size={24} />
          </div>
          <h1 className="mt-8 text-3xl font-semibold leading-tight">Data Room</h1>
          <p className="mt-4 max-w-md text-sm leading-6 text-white/78">
            Project Horizon diligence materials.
          </p>
        </div>

        <form onSubmit={submit} className="p-8 md:p-10">
          <div className="flex rounded-md bg-[#eef2f0] p-1">
            <button
              type="button"
              onClick={() => setMode("login")}
              className={`h-9 flex-1 rounded px-3 text-sm font-medium ${
                mode === "login" ? "bg-white text-[#1e2528] shadow-sm" : "text-[#667478]"
              }`}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => setMode("register")}
              className={`h-9 flex-1 rounded px-3 text-sm font-medium ${
                mode === "register" ? "bg-white text-[#1e2528] shadow-sm" : "text-[#667478]"
              }`}
            >
              Create account
            </button>
          </div>

          <h2 className="mt-7 text-xl font-semibold text-[#1f2a2d]">
            {mode === "login" ? "Welcome back" : "Create your workspace"}
          </h2>
          <p className="mt-2 text-sm text-[#667478]">
            Sign in with your account or create a new one.
          </p>

          <div className="mt-5 space-y-4">
            {message ? <Notice>{message}</Notice> : null}
            {error ? <Notice tone="danger">{error}</Notice> : null}

            {mode === "register" ? (
              <label className="block text-sm font-medium text-[#334044]">
                Name
                <TextInput className="mt-1.5" value={name} onChange={(event) => setName(event.target.value)} />
              </label>
            ) : null}
            <label className="block text-sm font-medium text-[#334044]">
              Email
              <TextInput
                className="mt-1.5"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="block text-sm font-medium text-[#334044]">
              Password
              <TextInput
                className="mt-1.5"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          </div>

          <Button className="mt-6 w-full" disabled={loading}>
            {loading ? <Spinner /> : null}
            {mode === "login" ? "Sign in" : "Create account"}
          </Button>
        </form>
      </section>
    </main>
  );
}
