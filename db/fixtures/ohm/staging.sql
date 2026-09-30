DROP SCHEMA IF EXISTS ohm_stage CASCADE;
CREATE SCHEMA ohm_stage;
CREATE TABLE ohm_stage.boundaries (
  osm_id bigint PRIMARY KEY,
  tags jsonb NOT NULL,
  geom geometry(MultiPolygon, 4326) NOT NULL
);

INSERT INTO ohm_stage.boundaries (osm_id, tags, geom) VALUES
-- accepted: level 2, name:en preferred over name, overlaps HB "Kingdom A" (lon 0..10)
(1, '{"boundary":"administrative","admin_level":"2","name":"Reich X","name:en":"Realm X","start_date":"1050","end_date":"1080"}',
 ST_Multi(ST_GeomFromText('POLYGON((0 40,10 40,10 50,0 50,0 40))', 4326))),
-- accepted: level 4 region inside Realm X
(2, '{"boundary":"administrative","admin_level":"4","name":"Region R","name:en":"Region R","start_date":"1060","end_date":"1070"}',
 ST_Multi(ST_GeomFromText('POLYGON((0 40,5 40,5 45,0 45,0 40))', 4326))),
-- accepted: CC0 licence, open-ended, outside HB coverage
(3, '{"boundary":"administrative","admin_level":"2","name":"Licensed Land","name:en":"Licensed Land","start_date":"1000","license":"CC0-1.0"}',
 ST_Multi(ST_GeomFromText('POLYGON((30 40,35 40,35 45,30 45,30 40))', 4326))),
-- accepted: no name:en, falls back to name
(4, '{"boundary":"administrative","admin_level":"2","name":"Reich ohne Englisch","start_date":"1200"}',
 ST_Multi(ST_GeomFromText('POLYGON((36 40,40 40,40 45,36 45,36 40))', 4326))),
-- skipped: unparsable date
(5, '{"boundary":"administrative","admin_level":"2","name":"Bad Date Land","name:en":"Bad Date Land","start_date":"c. 1500"}',
 ST_Multi(ST_GeomFromText('POLYGON((20 40,25 40,25 45,20 45,20 40))', 4326))),
-- skipped: end before start (seen in the real data)
(6, '{"boundary":"administrative","admin_level":"2","name":"Reversed Land","name:en":"Reversed Land","start_date":"1300","end_date":"1200"}',
 ST_Multi(ST_GeomFromText('POLYGON((20 40,25 40,25 45,20 45,20 40))', 4326))),
-- skipped: share-alike licence
(7, '{"boundary":"administrative","admin_level":"2","name":"Share Alike Land","name:en":"Share Alike Land","start_date":"1000","license":"CC-BY-SA-4.0"}',
 ST_Multi(ST_GeomFromText('POLYGON((20 40,25 40,25 45,20 45,20 40))', 4326))),
-- filtered out by the Europe bbox (never counted)
(8, '{"boundary":"administrative","admin_level":"2","name":"Far Realm","name:en":"Far Realm","start_date":"1000"}',
 ST_Multi(ST_GeomFromText('POLYGON((100 40,110 40,110 50,100 50,100 40))', 4326)));
