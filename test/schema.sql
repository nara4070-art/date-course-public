-- A "space" is one couple's shared calendar. The first person signs up and
-- creates a space; the second joins it through a one-time QR invite.
CREATE TABLE IF NOT EXISTS spaces (
  id         text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id           text PRIMARY KEY,
  space_id     text        NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  username     text        NOT NULL UNIQUE,          -- stored lowercase
  display_name text        NOT NULL,
  pw_salt      text        NOT NULL,
  pw_hash      text        NOT NULL,                 -- PBKDF2-SHA256, 100k iterations
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_space_idx ON users (space_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,                      -- sha256 of the cookie value
  user_id    text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS invites (
  token_hash text PRIMARY KEY,                      -- sha256 of the token in the QR link
  space_id   text        NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  created_by text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_by    text        REFERENCES users(id) ON DELETE SET NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS courses (
  id         text PRIMARY KEY,
  date       date        NOT NULL,
  mood       text        NOT NULL,
  title      text        NOT NULL DEFAULT '',
  places     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  foods      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  memo       text        NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- space_id NULL = a record of the no-login version (original URL);
-- set = a record of that space in the login version.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS space_id text REFERENCES spaces(id) ON DELETE CASCADE;
DROP INDEX IF EXISTS courses_date_idx;
CREATE INDEX IF NOT EXISTS courses_space_date_idx ON courses (space_id, date, created_at);
