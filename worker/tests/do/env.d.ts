// The pool hands each test the Worker's own bindings; this is what tells
// TypeScript that `env` from "cloudflare:test" is this project's Env.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
