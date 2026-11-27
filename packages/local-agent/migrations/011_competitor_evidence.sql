-- 011 — Evidência comparativa bruta para frete, prazo, patrocínio e imagens.
-- Não conclui similaridade visual a partir de URL; só grava prova observada.
ALTER TABLE competitor_monitoring_points ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE competitor_monitoring_points ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '{}';
