import { DEFAULT_HEADER as organisationHeader } from "@softistx/alxia-tenancy";
import { clientHeader } from "../src/http/csrf";
import type { AuthApp } from "./auth";

export interface GraphQLFailure {
  message: string;
  extensions?: {
    code?: string;
    params?: Record<string, unknown>;
    fields?: { path: string; code: string }[];
    http?: { status: number };
  };
}

// A GraphQL client over the real app and a real HTTP-shaped request (headers,
// body, JSON answer), with raw operation strings: a flow spec reads like what a
// front end sends. `call` returns the data and throws the errors; `attempt`
// returns both, for a refusal.
export function http(
  kit: Pick<AuthApp, "app">,
  token: string | null,
  options: {
    organisation?: string;
    language?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const attempt = async <T = Record<string, never>>(
    query: string,
    variables?: Record<string, unknown>,
  ) => {
    const response = await kit.app.fetch(
      new Request("https://ui.pulsarix.test/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [clientHeader]: "spec",
          ...(token && { authorization: `Bearer ${token}` }),
          ...(options.organisation && {
            [organisationHeader]: options.organisation,
          }),
          ...(options.language && { "accept-language": options.language }),
          ...options.headers,
        },
        body: JSON.stringify({ query, variables }),
      }),
    );
    return (await response.json()) as {
      data?: T | null;
      errors?: GraphQLFailure[];
    };
  };
  const call = async <T = Record<string, never>>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> => {
    const answer = await attempt<T>(query, variables);
    if (answer.errors) throw new Error(JSON.stringify(answer.errors));
    return answer.data as T;
  };
  return { attempt, call };
}

export type Http = ReturnType<typeof http>;

// The `extensions.code` of a GraphQL response's first error.
export const codeOf = (result: {
  errors?: readonly { extensions?: { code?: string } }[];
}) => result.errors?.[0]?.extensions?.code;
