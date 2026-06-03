import { Pool, type PoolClient, type PoolConfig } from "pg";

export type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

export interface CreatePgPoolInput {
  connectionString?: string;
  max?: number;
}

export function createPgPool(input: CreatePgPoolInput = {}): Pool {
  const connectionString = input.connectionString ?? process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required to create a PostgreSQL pool");
  }

  const config: PoolConfig = {
    connectionString,
    max: input.max ?? Number(process.env.DB_POOL_MAX ?? 10),
  };

  return new Pool(config);
}

export async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
