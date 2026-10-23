CREATE TABLE IF NOT EXISTS post_spectral_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pasture_id UUID NOT NULL REFERENCES pastures(id) ON DELETE CASCADE,
  year INTEGER NOT NULL CHECK (year BETWEEN 2017 AND 2200),
  status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'READY', 'FAILED')),
  algorithm TEXT NOT NULL DEFAULT 'Deterministic K-means',
  feature_schema JSONB NOT NULL DEFAULT '[]',
  observation_ids UUID[] NOT NULL DEFAULT '{}',
  sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  cluster_count INTEGER NOT NULL DEFAULT 0 CHECK (cluster_count >= 0),
  confidence DOUBLE PRECISION CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
  result JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pasture_id, year)
);

CREATE INDEX IF NOT EXISTS post_spectral_analyses_pasture_year
  ON post_spectral_analyses (pasture_id, year DESC);

DROP TRIGGER IF EXISTS post_spectral_analyses_updated_at ON post_spectral_analyses;
CREATE TRIGGER post_spectral_analyses_updated_at
  BEFORE UPDATE ON post_spectral_analyses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
