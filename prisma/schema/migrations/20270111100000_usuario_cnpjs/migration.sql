-- Usuário limitado a alguns CNPJs do grupo (vazio = vê todos)
ALTER TABLE "User" ADD COLUMN "entityIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
