-- Migration 002 : comptes utilisateurs et sessions (étape 3, décisions D-010 et D-011).
-- Schéma de docs/cadrage.md §3. Aucun compte n'est créé ici : les comptes sont créés
-- uniquement par la commande « node server/main.js user-add <identifiant> ».

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  -- Identifiant limité à [A-Za-z0-9._-], 1 à 64 caractères (même règle que user-add) :
  -- il peut ainsi être affiché dans les pages sans échappement. Le CHECK est un filet
  -- au niveau base si un compte était inséré par un autre chemin.
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE
                CHECK (length(username) BETWEEN 1 AND 64 AND username NOT GLOB '*[^A-Za-z0-9._-]*'),
  password_hash TEXT    NOT NULL,                 -- argon2id au format PHC ; jamais le mot de passe
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT    NOT NULL
);

CREATE TABLE sessions (
  -- SHA-256 du jeton de session (32 octets) ; le jeton en clair n'existe que dans le cookie
  -- du navigateur. Une copie de la base ne permet donc pas de reprendre une session.
  token_hash  BLOB    PRIMARY KEY CHECK (length(token_hash) = 32),
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL                    -- durée absolue, jamais prolongée
) WITHOUT ROWID;
