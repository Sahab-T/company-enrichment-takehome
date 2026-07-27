import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anonKey) {
  console.warn(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — copy web/.env.example to web/.env. " +
      "Falling back to local defaults so the app still boots; data calls will fail until you set these.",
  );
}

// Fall back to the default local Supabase URL so the app still renders before you
// configure .env (otherwise createClient throws on an empty URL). Run `supabase start`
// and set the real values in web/.env to connect.
export const supabase = createClient(
  url || "http://127.0.0.1:54321",
  anonKey || "public-anon-key",
);
