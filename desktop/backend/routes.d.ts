declare module "desktop:routes" {
  export const routes: { path: string; handlers: Record<string,
    (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response> | Response> }[];
}
