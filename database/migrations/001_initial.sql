CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS pastures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  geometry geometry(MultiPolygon, 4326) NOT NULL,
  area_ha DOUBLE PRECISION NOT NULL CHECK (area_ha > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pastures_geometry_gist ON pastures USING GIST (geometry);

CREATE TABLE IF NOT EXISTS satellite_scenes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pasture_id UUID NOT NULL REFERENCES pastures(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  satellite TEXT NOT NULL DEFAULT 'Sentinel-2',
  acquisition_date TIMESTAMPTZ NOT NULL,
  month SMALLINT NOT NULL CHECK (month BETWEEN 5 AND 9),
  cloud_cover DOUBLE PRECISION,
  aoi_cloud_percentage DOUBLE PRECISION,
  valid_coverage_percentage DOUBLE PRECISION,
  geographic_coverage_percentage DOUBLE PRECISION,
  selected BOOLEAN NOT NULL DEFAULT false,
  footprint geometry(MultiPolygon, 4326),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pasture_id, product_id)
);
CREATE INDEX IF NOT EXISTS satellite_scenes_footprint_gist ON satellite_scenes USING GIST (footprint);
CREATE INDEX IF NOT EXISTS satellite_scenes_pasture_date ON satellite_scenes (pasture_id, acquisition_date);

CREATE TABLE IF NOT EXISTS ndvi_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pasture_id UUID NOT NULL REFERENCES pastures(id) ON DELETE CASCADE,
  scene_id UUID REFERENCES satellite_scenes(id) ON DELETE SET NULL,
  year INTEGER NOT NULL CHECK (year BETWEEN 2017 AND 2200),
  month SMALLINT NOT NULL CHECK (month BETWEEN 5 AND 9),
  acquisition_date TIMESTAMPTZ,
  ndvi_mean DOUBLE PRECISION,
  ndvi_median DOUBLE PRECISION,
  ndvi_min DOUBLE PRECISION,
  ndvi_max DOUBLE PRECISION,
  ndvi_std DOUBLE PRECISION,
  cloud_percentage DOUBLE PRECISION,
  valid_coverage_percentage DOUBLE PRECISION,
  status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'READY', 'NO_SUITABLE_IMAGE', 'FAILED')),
  processing_version INTEGER NOT NULL DEFAULT 1,
  is_synthetic BOOLEAN NOT NULL DEFAULT false,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pasture_id, year, month, processing_version)
);
CREATE INDEX IF NOT EXISTS ndvi_observations_pasture_period ON ndvi_observations (pasture_id, year, month, processing_version DESC);

CREATE TABLE IF NOT EXISTS raster_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id UUID REFERENCES ndvi_observations(id) ON DELETE CASCADE,
  prediction_id UUID,
  asset_type TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  raster_data BYTEA NOT NULL,
  crs TEXT NOT NULL DEFAULT 'EPSG:4326',
  bbox JSONB NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  resolution DOUBLE PRECISION,
  checksum TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (observation_id, asset_type)
);

CREATE TABLE IF NOT EXISTS ndvi_classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id UUID NOT NULL REFERENCES ndvi_observations(id) ON DELETE CASCADE,
  class_name TEXT NOT NULL,
  class_id INTEGER NOT NULL CHECK (class_id BETWEEN 1 AND 5),
  color VARCHAR(16) NOT NULL,
  area_ha DOUBLE PRECISION NOT NULL CHECK (area_ha >= 0),
  percentage DOUBLE PRECISION NOT NULL CHECK (percentage BETWEEN 0 AND 100),
  UNIQUE (observation_id, class_id)
);

CREATE TABLE IF NOT EXISTS training_annotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pasture_id UUID NOT NULL REFERENCES pastures(id) ON DELETE CASCADE,
  observation_id UUID NOT NULL REFERENCES ndvi_observations(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL,
  geometry geometry(MultiPolygon, 4326) NOT NULL,
  area_ha DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS training_annotations_geometry_gist ON training_annotations USING GIST (geometry);
CREATE INDEX IF NOT EXISTS training_annotations_observation ON training_annotations (observation_id);

CREATE TABLE IF NOT EXISTS training_datasets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  feature_schema JSONB NOT NULL,
  sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
  class_distribution JSONB NOT NULL,
  dataset_data BYTEA NOT NULL,
  is_synthetic BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ml_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'Random Forest Classifier',
  model_version INTEGER NOT NULL,
  model_data BYTEA NOT NULL,
  feature_schema JSONB NOT NULL,
  hyperparameters JSONB NOT NULL,
  preprocessing JSONB NOT NULL DEFAULT '{}',
  metrics JSONB NOT NULL,
  dataset_id UUID REFERENCES training_datasets(id) ON DELETE SET NULL,
  is_synthetic BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, model_version)
);

CREATE TABLE IF NOT EXISTS ml_training_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id UUID NOT NULL REFERENCES training_datasets(id) ON DELETE RESTRICT,
  model_id UUID REFERENCES ml_models(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'active', 'completed', 'failed')),
  parameters JSONB NOT NULL,
  metrics JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ml_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id UUID NOT NULL REFERENCES ml_models(id) ON DELETE RESTRICT,
  observation_id UUID NOT NULL REFERENCES ndvi_observations(id) ON DELETE CASCADE,
  segmentation_asset_id UUID,
  statistics JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (model_id, observation_id)
);
ALTER TABLE raster_assets DROP CONSTRAINT IF EXISTS raster_assets_prediction_id_fkey;
ALTER TABLE raster_assets ADD CONSTRAINT raster_assets_prediction_id_fkey FOREIGN KEY (prediction_id) REFERENCES ml_predictions(id) ON DELETE CASCADE;
ALTER TABLE ml_predictions DROP CONSTRAINT IF EXISTS ml_predictions_segmentation_asset_id_fkey;
ALTER TABLE ml_predictions ADD CONSTRAINT ml_predictions_segmentation_asset_id_fkey FOREIGN KEY (segmentation_asset_id) REFERENCES raster_assets(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS processing_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pasture_id UUID REFERENCES pastures(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  queue_job_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'active', 'completed', 'failed')),
  progress INTEGER CHECK (progress IS NULL OR progress BETWEEN 0 AND 100),
  result JSONB,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS processing_jobs_pasture ON processing_jobs (pasture_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  satellite JSONB NOT NULL DEFAULT '{"cloudThreshold":10,"minimumValidCoverage":90,"resolution":10}',
  ndvi_classes JSONB NOT NULL DEFAULT '[{"id":1,"name":"Очень низкий","min":-1,"max":0.15,"color":"#dc3c3c"},{"id":2,"name":"Низкий","min":0.15,"max":0.3,"color":"#ec8b2c"},{"id":3,"name":"Средний","min":0.3,"max":0.45,"color":"#e4c844"},{"id":4,"name":"Хороший","min":0.45,"max":0.6,"color":"#7fbf58"},{"id":5,"name":"Очень хороший","min":0.6,"max":1.01,"color":"#247a4b"}]',
  ml JSONB NOT NULL DEFAULT '{"numberOfTrees":100,"seed":42}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pastures_updated_at ON pastures;
CREATE TRIGGER pastures_updated_at BEFORE UPDATE ON pastures FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS annotations_updated_at ON training_annotations;
CREATE TRIGGER annotations_updated_at BEFORE UPDATE ON training_annotations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
