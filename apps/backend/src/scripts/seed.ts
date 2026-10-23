import { pool } from "../db.js";
import { createPasture } from "../repositories.js";
import { env } from "../env.js";
import { hashPassword } from "../auth.js";

if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
  const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
  await pool.query(
    `INSERT INTO users (name,email,password_hash,role,is_active)
     VALUES ($1,lower($2),$3,'ADMIN',true)
     ON CONFLICT (lower(email)) DO UPDATE SET name=EXCLUDED.name,password_hash=EXCLUDED.password_hash,role='ADMIN',is_active=true`,
    [env.ADMIN_NAME, env.ADMIN_EMAIL, passwordHash]
  );
  console.log(`Administrator account ready: ${env.ADMIN_EMAIL}`);
}

const existing = await pool.query("SELECT id FROM pastures LIMIT 1");
if (!existing.rowCount) {
  const pasture = await createPasture(pool, {
    name: "Пастбище Есиль",
    description: "Демонстрационная территория в Северо-Казахстанской области",
    geometry: { type: "Polygon", coordinates: [[[69.05,54.72],[69.18,54.72],[69.18,54.80],[69.05,54.80],[69.05,54.72]]] }
  });
  console.log(`Created demo pasture ${pasture.id}`);
}
await pool.end();
