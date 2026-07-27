-- =============================================================================
-- seed.sql — loads companies_seed.json into public.companies.
--
-- `supabase db reset` runs this automatically after the migrations. To load it
-- against a hosted project instead, paste this file into the SQL editor.
--
-- Notes:
--   * The seed file's integer `id`s are dropped — the table uses uuid PKs and
--     those ids carry no meaning beyond ordering in the JSON file.
--   * The rows are loaded VERBATIM, messiness included: the leading spaces in
--     "  Zalando SE", the empty-string domains, the "siemens" near-duplicate of
--     "Siemens AG". `companies` is the raw layer; normalising here would throw
--     away the exact problem the enrichment step exists to solve.
--   * `owner_id` is left NULL, which the RLS policy in 0001_init.sql treats as
--     an unowned demo row visible to everyone. That is what lets the dashboard
--     show data before auth is wired up.
--   * Guarded by NOT EXISTS so re-running is a no-op rather than a duplicate load.
-- =============================================================================

insert into public.companies (name, domain, raw_note)
select v.name, v.domain, v.raw_note
from (
  values
    ('Siemens AG',       'siemens.com',      'Large industrial/tech conglomerate, Munich. ~300k employees worldwide.'),
    ('siemens',          '',                 'duplicate? munich electronics'),
    ('  Zalando SE',     'zalando.de',       'online fashion retailer berlin'),
    ('DB Schenker',      null,               'Logistics arm of Deutsche Bahn. HQ Essen.'),
    ('N26 GmbH',         'n26.com',          'mobile bank / fintech, Berlin, a few thousand staff'),
    ('Trumpf',           'trumpf.com',       'machine tools + lasers, family-owned, Ditzingen'),
    ('About You',        'aboutyou.com',     'Hamburg e-commerce, fashion'),
    ('Celonis',          'celonis.com',      'process mining software, Munich/NYC, unicorn'),
    ('Personio',         '',                 'HR software for SMEs, München'),
    ('BioNTech SE',      'biontech.de',      'Mainz biotech, mRNA, ~5000 ppl'),
    ('flixbus',          'flixbus.com',      'FlixMobility - buses + trains, Munich'),
    ('GetYourGuide',     'getyourguide.com', 'travel experiences marketplace, Berlin'),
    ('Robert Bosch GmbH','bosch.com',        'engineering + tech, Gerlingen, very large'),
    ('DeepL',            'deepl.com',        'AI translation, Köln'),
    ('Winterhalter',     '',                 'commercial dishwashing systems, Meckenbeuren - mittelstand')
) as v (name, domain, raw_note)
where not exists (select 1 from public.companies);
