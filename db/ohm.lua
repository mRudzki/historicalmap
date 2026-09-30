-- osm2pgsql flex style: OHM administrative boundaries (admin_level 2-4) with a start_date,
-- loaded as multipolygons into ohm_stage.boundaries. Imported by scripts/import-ohm.ts.
local boundaries = osm2pgsql.define_table({
  name = 'boundaries',
  schema = 'ohm_stage',
  ids = { type = 'relation', id_column = 'osm_id' },
  columns = {
    { column = 'tags', type = 'jsonb' },
    { column = 'geom', type = 'multipolygon', projection = 4326, not_null = true },
  },
})

local levels = { ['2'] = true, ['3'] = true, ['4'] = true }

function osm2pgsql.process_relation(object)
  local t = object.tags
  if t.boundary ~= 'administrative' or not levels[t.admin_level] or not t.start_date then
    return
  end
  if t.type ~= 'boundary' and t.type ~= 'multipolygon' then
    return
  end
  local geom = object:as_multipolygon()
  if geom:is_null() then
    return
  end
  boundaries:insert({ tags = t, geom = geom })
end
