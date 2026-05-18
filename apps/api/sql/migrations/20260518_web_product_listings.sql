-- 20260518_web_product_listings.sql
-- Websites & Web Products as a first-class listing category
-- Adds: HTML_EMBED, TECH_STACK, URL_PREVIEW, CODE_BLOCK, METRIC_DISPLAY, BADGE field types
-- Adds: advert_web_listing_meta for rich website metadata
-- Seeds: web-product category with 8 subcategories and 28 listing types

DO $$
DECLARE
  -- category
  cat_web UUID;

  -- subcategories
  sub_web_business   UUID;
  sub_web_saas       UUID;
  sub_web_ecommerce  UUID;
  sub_web_portfolio  UUID;
  sub_web_blog       UUID;
  sub_web_tool       UUID;
  sub_web_game       UUID;
  sub_web_api        UUID;

  -- listing types
  lt_biz_corporate   UUID;
  lt_biz_landing     UUID;
  lt_biz_restaurant  UUID;
  lt_biz_hotel       UUID;
  lt_biz_clinic      UUID;
  lt_biz_school      UUID;
  lt_saas_b2b        UUID;
  lt_saas_b2c        UUID;
  lt_saas_crm        UUID;
  lt_saas_analytics  UUID;
  lt_ecom_store      UUID;
  lt_ecom_market     UUID;
  lt_ecom_booking    UUID;
  lt_portfolio_dev   UUID;
  lt_portfolio_design UUID;
  lt_portfolio_photo  UUID;
  lt_blog_news        UUID;
  lt_blog_niche       UUID;
  lt_blog_affiliate   UUID;
  lt_tool_calculator  UUID;
  lt_tool_generator   UUID;
  lt_tool_converter   UUID;
  lt_tool_checker     UUID;
  lt_game_browser     UUID;
  lt_game_puzzle      UUID;
  lt_api_rest         UUID;
  lt_api_sdk          UUID;
  lt_api_data         UUID;

BEGIN

-- ─────────────────────────────────────────────────────────────────
-- 1. EXTEND field_type CHECK CONSTRAINT
-- ─────────────────────────────────────────────────────────────────

-- Drop old constraint, add new one that includes web-specific types
ALTER TABLE advert_field_definitions
  DROP CONSTRAINT IF EXISTS advert_field_definitions_field_type_check;

ALTER TABLE advert_field_definitions
  ADD CONSTRAINT advert_field_definitions_field_type_check
  CHECK (field_type IN (
    'TEXT', 'TEXTAREA', 'SELECT', 'MULTISELECT',
    'NUMBER', 'CURRENCY', 'BOOLEAN', 'DATE',
    'LOCATION', 'PHONE', 'EMAIL', 'URL',
    -- web-specific
    'HTML_EMBED',    -- paste HTML, rendered in WebView on product page
    'TECH_STACK',    -- comma-joined tech tags rendered as colour badges
    'URL_PREVIEW',   -- URL that shows an open-in-browser card
    'CODE_BLOCK',    -- monospace code display (no rendering)
    'METRIC_DISPLAY',-- "10K monthly users" style KPI chips
    'BADGE'          -- status badge: Live | Beta | Open Source | Monetised etc.
  ));

-- ─────────────────────────────────────────────────────────────────
-- 2. WEB LISTING META TABLE
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advert_web_listing_meta (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id            UUID NOT NULL UNIQUE REFERENCES advert_listings(id) ON DELETE CASCADE,

  -- live site info
  website_url           TEXT,
  demo_url              TEXT,
  github_url            TEXT,
  is_open_source        BOOLEAN NOT NULL DEFAULT FALSE,

  -- preview
  screenshot_url        TEXT,        -- uploaded or auto-captured screenshot
  preview_html          TEXT,        -- raw HTML pasted by programmer for embedded preview

  -- audience / scale
  monthly_visitors      INTEGER,
  monthly_revenue_usd   NUMERIC,
  registered_users      INTEGER,
  countries_served      INTEGER,

  -- technical
  tech_stack            TEXT[],      -- ['React','Node','PostgreSQL']
  is_mobile_responsive  BOOLEAN NOT NULL DEFAULT TRUE,
  has_ssl               BOOLEAN NOT NULL DEFAULT TRUE,
  page_speed_score      INTEGER CHECK (page_speed_score BETWEEN 0 AND 100),
  domain_age_months     INTEGER,

  -- status
  launch_date           DATE,
  stage                 TEXT CHECK (stage IN ('IDEA','MVP','BETA','LIVE','MONETISED','FOR_SALE','ACQUIRED')),
  is_for_sale           BOOLEAN NOT NULL DEFAULT FALSE,
  asking_price_usd      NUMERIC,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_meta_listing ON advert_web_listing_meta(listing_id);

-- ─────────────────────────────────────────────────────────────────
-- 3. CATEGORY
-- ─────────────────────────────────────────────────────────────────

INSERT INTO advert_categories (slug, name, icon, sort_order) VALUES
  ('web-product', 'Website & Web Product', '🌐', 26)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO cat_web FROM advert_categories WHERE slug = 'web-product';

-- ─────────────────────────────────────────────────────────────────
-- 4. SUBCATEGORIES
-- ─────────────────────────────────────────────────────────────────

INSERT INTO advert_subcategories (category_id, slug, name, sort_order) VALUES
  (cat_web, 'web-business',   'Business Website',      1),
  (cat_web, 'web-saas',       'SaaS / Web Application',2),
  (cat_web, 'web-ecommerce',  'E-Commerce Store',      3),
  (cat_web, 'web-portfolio',  'Portfolio & Personal',  4),
  (cat_web, 'web-blog',       'Blog & Publication',    5),
  (cat_web, 'web-tool',       'Online Tool / Utility', 6),
  (cat_web, 'web-game',       'Browser Game',          7),
  (cat_web, 'web-api',        'API & Developer Product',8)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO sub_web_business   FROM advert_subcategories WHERE slug = 'web-business';
SELECT id INTO sub_web_saas       FROM advert_subcategories WHERE slug = 'web-saas';
SELECT id INTO sub_web_ecommerce  FROM advert_subcategories WHERE slug = 'web-ecommerce';
SELECT id INTO sub_web_portfolio  FROM advert_subcategories WHERE slug = 'web-portfolio';
SELECT id INTO sub_web_blog       FROM advert_subcategories WHERE slug = 'web-blog';
SELECT id INTO sub_web_tool       FROM advert_subcategories WHERE slug = 'web-tool';
SELECT id INTO sub_web_game       FROM advert_subcategories WHERE slug = 'web-game';
SELECT id INTO sub_web_api        FROM advert_subcategories WHERE slug = 'web-api';

-- ─────────────────────────────────────────────────────────────────
-- 5. LISTING TYPES
-- ─────────────────────────────────────────────────────────────────

-- Business Website
INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order) VALUES
  (sub_web_business, 'web-biz-corporate',   'Corporate / Company Site', 1),
  (sub_web_business, 'web-biz-landing',     'Landing Page / Funnel',    2),
  (sub_web_business, 'web-biz-restaurant',  'Restaurant / Food Brand',  3),
  (sub_web_business, 'web-biz-hotel',       'Hotel / Accommodation',    4),
  (sub_web_business, 'web-biz-clinic',      'Clinic / Health Practice', 5),
  (sub_web_business, 'web-biz-school',      'School / Academy',         6)
ON CONFLICT (slug) DO NOTHING;

-- SaaS / Web App
INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order) VALUES
  (sub_web_saas, 'web-saas-b2b',        'B2B SaaS Platform',     1),
  (sub_web_saas, 'web-saas-b2c',        'Consumer Web App',      2),
  (sub_web_saas, 'web-saas-crm',        'CRM / Project Tool',    3),
  (sub_web_saas, 'web-saas-analytics',  'Analytics / Dashboard', 4)
ON CONFLICT (slug) DO NOTHING;

-- E-Commerce
INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order) VALUES
  (sub_web_ecommerce, 'web-ecom-store',    'Online Store',        1),
  (sub_web_ecommerce, 'web-ecom-market',   'Marketplace / Multi-vendor', 2),
  (sub_web_ecommerce, 'web-ecom-booking',  'Booking / Reservation Site', 3)
ON CONFLICT (slug) DO NOTHING;

-- Portfolio
INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order) VALUES
  (sub_web_portfolio, 'web-port-dev',      'Developer Portfolio',     1),
  (sub_web_portfolio, 'web-port-design',   'Design / Creative Portfolio', 2),
  (sub_web_portfolio, 'web-port-photo',    'Photography Portfolio',   3)
ON CONFLICT (slug) DO NOTHING;

-- Blog
INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order) VALUES
  (sub_web_blog, 'web-blog-news',       'News / Magazine Site',    1),
  (sub_web_blog, 'web-blog-niche',      'Niche Blog / Community',  2),
  (sub_web_blog, 'web-blog-affiliate',  'Affiliate / Review Blog', 3)
ON CONFLICT (slug) DO NOTHING;

-- Online Tool
INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order) VALUES
  (sub_web_tool, 'web-tool-calculator', 'Calculator / Estimator', 1),
  (sub_web_tool, 'web-tool-generator',  'Generator / Builder',    2),
  (sub_web_tool, 'web-tool-converter',  'Converter / Transformer',3),
  (sub_web_tool, 'web-tool-checker',    'Checker / Validator',    4)
ON CONFLICT (slug) DO NOTHING;

-- Browser Game
INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order) VALUES
  (sub_web_game, 'web-game-browser',    'Browser / HTML5 Game',   1),
  (sub_web_game, 'web-game-puzzle',     'Puzzle / Word Game',     2)
ON CONFLICT (slug) DO NOTHING;

-- API / Dev Product
INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order) VALUES
  (sub_web_api, 'web-api-rest',         'REST API / Endpoint',     1),
  (sub_web_api, 'web-api-sdk',          'SDK / Library',           2),
  (sub_web_api, 'web-api-data',         'Data / Dataset Product',  3)
ON CONFLICT (slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────
-- FETCH LISTING TYPE IDS
-- ─────────────────────────────────────────────────────────────────

SELECT id INTO lt_biz_corporate   FROM advert_listing_types WHERE slug = 'web-biz-corporate';
SELECT id INTO lt_biz_landing     FROM advert_listing_types WHERE slug = 'web-biz-landing';
SELECT id INTO lt_biz_restaurant  FROM advert_listing_types WHERE slug = 'web-biz-restaurant';
SELECT id INTO lt_biz_hotel       FROM advert_listing_types WHERE slug = 'web-biz-hotel';
SELECT id INTO lt_biz_clinic      FROM advert_listing_types WHERE slug = 'web-biz-clinic';
SELECT id INTO lt_biz_school      FROM advert_listing_types WHERE slug = 'web-biz-school';
SELECT id INTO lt_saas_b2b        FROM advert_listing_types WHERE slug = 'web-saas-b2b';
SELECT id INTO lt_saas_b2c        FROM advert_listing_types WHERE slug = 'web-saas-b2c';
SELECT id INTO lt_saas_crm        FROM advert_listing_types WHERE slug = 'web-saas-crm';
SELECT id INTO lt_saas_analytics  FROM advert_listing_types WHERE slug = 'web-saas-analytics';
SELECT id INTO lt_ecom_store      FROM advert_listing_types WHERE slug = 'web-ecom-store';
SELECT id INTO lt_ecom_market     FROM advert_listing_types WHERE slug = 'web-ecom-market';
SELECT id INTO lt_ecom_booking    FROM advert_listing_types WHERE slug = 'web-ecom-booking';
SELECT id INTO lt_portfolio_dev   FROM advert_listing_types WHERE slug = 'web-port-dev';
SELECT id INTO lt_portfolio_design FROM advert_listing_types WHERE slug = 'web-port-design';
SELECT id INTO lt_portfolio_photo  FROM advert_listing_types WHERE slug = 'web-port-photo';
SELECT id INTO lt_blog_news        FROM advert_listing_types WHERE slug = 'web-blog-news';
SELECT id INTO lt_blog_niche       FROM advert_listing_types WHERE slug = 'web-blog-niche';
SELECT id INTO lt_blog_affiliate   FROM advert_listing_types WHERE slug = 'web-blog-affiliate';
SELECT id INTO lt_tool_calculator  FROM advert_listing_types WHERE slug = 'web-tool-calculator';
SELECT id INTO lt_tool_generator   FROM advert_listing_types WHERE slug = 'web-tool-generator';
SELECT id INTO lt_tool_converter   FROM advert_listing_types WHERE slug = 'web-tool-converter';
SELECT id INTO lt_tool_checker     FROM advert_listing_types WHERE slug = 'web-tool-checker';
SELECT id INTO lt_game_browser     FROM advert_listing_types WHERE slug = 'web-game-browser';
SELECT id INTO lt_game_puzzle      FROM advert_listing_types WHERE slug = 'web-game-puzzle';
SELECT id INTO lt_api_rest         FROM advert_listing_types WHERE slug = 'web-api-rest';
SELECT id INTO lt_api_sdk          FROM advert_listing_types WHERE slug = 'web-api-sdk';
SELECT id INTO lt_api_data         FROM advert_listing_types WHERE slug = 'web-api-data';

-- ─────────────────────────────────────────────────────────────────
-- 6. FIELD DEFINITIONS
-- Shared helper: we insert fields per listing type.
-- Section groups used: Identity, Live Site, Tech Stack, Audience & Metrics,
--   Monetisation, Technical, HTML Preview, Contact
-- ─────────────────────────────────────────────────────────────────

-- ── CORPORATE / COMPANY SITE ──────────────────────────────────────
INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
VALUES
  (lt_biz_corporate, 'website_url',       'Live Website URL',          'URL_PREVIEW',    TRUE,  1,  'https://yourcompany.com',  'Visitors can click to view your live site', 'Live Site'),
  (lt_biz_corporate, 'industry',          'Industry / Sector',         'SELECT',         TRUE,  2,  NULL, NULL, 'Identity'),
  (lt_biz_corporate, 'founded_year',      'Year Founded',              'NUMBER',         FALSE, 3,  '2021', NULL, 'Identity'),
  (lt_biz_corporate, 'headquarters',      'Headquarters / Location',   'TEXT',           FALSE, 4,  'Kampala, Uganda', NULL, 'Identity'),
  (lt_biz_corporate, 'team_size',         'Team Size',                 'SELECT',         FALSE, 5,  NULL, NULL, 'Identity'),
  (lt_biz_corporate, 'tech_stack',        'Tech Stack',                'TECH_STACK',     FALSE, 6,  'WordPress, React, …', 'Technologies used to build the site', 'Tech Stack'),
  (lt_biz_corporate, 'stage',             'Business Stage',            'BADGE',          FALSE, 7,  NULL, NULL, 'Identity'),
  (lt_biz_corporate, 'monthly_visitors',  'Monthly Visitors',          'METRIC_DISPLAY', FALSE, 8,  '10000', 'Approximate unique visitors per month', 'Audience & Metrics'),
  (lt_biz_corporate, 'has_ssl',           'Has SSL Certificate (HTTPS)','BOOLEAN',       FALSE, 9,  NULL, NULL, 'Technical'),
  (lt_biz_corporate, 'is_mobile_ready',   'Mobile Responsive',         'BOOLEAN',        FALSE, 10, NULL, NULL, 'Technical'),
  (lt_biz_corporate, 'html_embed',        'HTML Preview (optional)',    'HTML_EMBED',     FALSE, 11, NULL, 'Paste raw HTML — it will be rendered live on your product page', 'HTML Preview'),
  (lt_biz_corporate, 'contact_email',     'Contact Email',             'EMAIL',          FALSE, 12, NULL, NULL, 'Contact'),
  (lt_biz_corporate, 'contact_phone',     'Contact Phone',             'PHONE',          FALSE, 13, NULL, NULL, 'Contact')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('Technology & Software','Technology & Software',1),
  ('Retail & E-Commerce','Retail & E-Commerce',2),
  ('Finance & Insurance','Finance & Insurance',3),
  ('Healthcare & Wellness','Healthcare & Wellness',4),
  ('Education & Training','Education & Training',5),
  ('Food & Hospitality','Food & Hospitality',6),
  ('Real Estate','Real Estate',7),
  ('Media & Entertainment','Media & Entertainment',8),
  ('NGO & Non-Profit','NGO & Non-Profit',9),
  ('Government & Civic','Government & Civic',10),
  ('Professional Services','Professional Services',11),
  ('Other','Other',12)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_biz_corporate AND fd.field_key = 'industry'
ON CONFLICT DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('1-5','1–5 people',1),('6-20','6–20 people',2),('21-50','21–50 people',3),
  ('51-200','51–200 people',4),('200+','200+ people',5)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_biz_corporate AND fd.field_key = 'team_size'
ON CONFLICT DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('LIVE','🟢 Live',1),('BETA','🟡 Beta',2),('MVP','🔵 MVP',3),
  ('FOR_SALE','💰 For Sale',4),('ACQUIRED','🏆 Acquired',5)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_biz_corporate AND fd.field_key = 'stage'
ON CONFLICT DO NOTHING;

-- ── LANDING PAGE / FUNNEL ─────────────────────────────────────────
INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
VALUES
  (lt_biz_landing, 'website_url',      'Live URL',               'URL_PREVIEW',    TRUE,  1, 'https://', NULL, 'Live Site'),
  (lt_biz_landing, 'conversion_goal',  'Conversion Goal',        'SELECT',         TRUE,  2, NULL, 'What action do you want visitors to take?', 'Identity'),
  (lt_biz_landing, 'tech_stack',       'Built With',             'TECH_STACK',     FALSE, 3, NULL, NULL, 'Tech Stack'),
  (lt_biz_landing, 'monthly_visitors', 'Monthly Traffic',        'METRIC_DISPLAY', FALSE, 4, NULL, NULL, 'Audience & Metrics'),
  (lt_biz_landing, 'conversion_rate',  'Conversion Rate (%)',    'NUMBER',         FALSE, 5, '3.5', NULL, 'Audience & Metrics'),
  (lt_biz_landing, 'html_embed',       'HTML Preview',           'HTML_EMBED',     FALSE, 6, NULL, 'Paste your landing page HTML for live preview', 'HTML Preview'),
  (lt_biz_landing, 'has_ssl',          'HTTPS / SSL',            'BOOLEAN',        FALSE, 7, NULL, NULL, 'Technical')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('sign_up','Sign Up / Register',1),('purchase','Purchase / Buy Now',2),
  ('contact','Contact / Enquiry',3),('download','Download / Install',4),
  ('subscribe','Subscribe / Newsletter',5),('book','Book / Schedule',6)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_biz_landing AND fd.field_key = 'conversion_goal'
ON CONFLICT DO NOTHING;

-- ── SAAS B2B ──────────────────────────────────────────────────────
INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
VALUES
  (lt_saas_b2b, 'website_url',      'App / Product URL',          'URL_PREVIEW',    TRUE,  1,  'https://', NULL, 'Live Site'),
  (lt_saas_b2b, 'demo_url',         'Live Demo URL',              'URL_PREVIEW',    FALSE, 2,  'https://demo.yourapp.com', NULL, 'Live Site'),
  (lt_saas_b2b, 'github_url',       'GitHub Repository',          'URL_PREVIEW',    FALSE, 3,  'https://github.com/...', NULL, 'Live Site'),
  (lt_saas_b2b, 'stage',            'Product Stage',              'BADGE',          TRUE,  4,  NULL, NULL, 'Identity'),
  (lt_saas_b2b, 'is_open_source',   'Open Source',                'BOOLEAN',        FALSE, 5,  NULL, NULL, 'Identity'),
  (lt_saas_b2b, 'pricing_model',    'Pricing Model',              'SELECT',         TRUE,  6,  NULL, NULL, 'Monetisation'),
  (lt_saas_b2b, 'mrr_usd',          'MRR (USD)',                  'METRIC_DISPLAY', FALSE, 7,  '5000', 'Monthly Recurring Revenue', 'Monetisation'),
  (lt_saas_b2b, 'active_customers', 'Active Customers / Seats',   'METRIC_DISPLAY', FALSE, 8,  NULL, NULL, 'Audience & Metrics'),
  (lt_saas_b2b, 'tech_stack',       'Tech Stack',                 'TECH_STACK',     TRUE,  9,  NULL, NULL, 'Tech Stack'),
  (lt_saas_b2b, 'api_available',    'Public API Available',       'BOOLEAN',        FALSE, 10, NULL, NULL, 'Technical'),
  (lt_saas_b2b, 'integrations',     'Key Integrations',           'TEXTAREA',       FALSE, 11, 'Slack, Stripe, HubSpot...', NULL, 'Technical'),
  (lt_saas_b2b, 'html_embed',       'Interactive Demo HTML',      'HTML_EMBED',     FALSE, 12, NULL, 'Embed a demo or marketing hero section', 'HTML Preview'),
  (lt_saas_b2b, 'code_sample',      'Code / API Sample',          'CODE_BLOCK',     FALSE, 13, NULL, 'Show developers how easy it is to integrate', 'HTML Preview'),
  (lt_saas_b2b, 'founded_year',     'Founded',                    'NUMBER',         FALSE, 14, NULL, NULL, 'Identity'),
  (lt_saas_b2b, 'contact_email',    'Contact / Sales Email',      'EMAIL',          FALSE, 15, NULL, NULL, 'Contact')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('LIVE','🟢 Live',1),('BETA','🟡 Beta',2),('MVP','🔵 MVP',3),
  ('IDEA','💡 Idea',4),('MONETISED','💰 Monetised',5),('FOR_SALE','🏷️ For Sale',6)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_saas_b2b AND fd.field_key = 'stage'
ON CONFLICT DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('freemium','Freemium',1),('subscription','Subscription / SaaS',2),
  ('per_seat','Per Seat / User',3),('usage_based','Usage Based',4),
  ('one_time','One-Time License',5),('free','Free / Open Source',6),
  ('enterprise','Enterprise / Custom',7)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_saas_b2b AND fd.field_key = 'pricing_model'
ON CONFLICT DO NOTHING;

-- ── SAAS B2C ──────────────────────────────────────────────────────
INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
VALUES
  (lt_saas_b2c, 'website_url',      'App URL',              'URL_PREVIEW',    TRUE,  1, NULL, NULL, 'Live Site'),
  (lt_saas_b2c, 'stage',            'Stage',                'BADGE',          TRUE,  2, NULL, NULL, 'Identity'),
  (lt_saas_b2c, 'pricing_model',    'Pricing Model',        'SELECT',         TRUE,  3, NULL, NULL, 'Monetisation'),
  (lt_saas_b2c, 'monthly_visitors', 'Monthly Active Users', 'METRIC_DISPLAY', FALSE, 4, NULL, NULL, 'Audience & Metrics'),
  (lt_saas_b2c, 'tech_stack',       'Tech Stack',           'TECH_STACK',     FALSE, 5, NULL, NULL, 'Tech Stack'),
  (lt_saas_b2c, 'html_embed',       'Product Hero HTML',    'HTML_EMBED',     FALSE, 6, NULL, 'Paste HTML for your product hero / onboarding screen', 'HTML Preview'),
  (lt_saas_b2c, 'is_open_source',   'Open Source',          'BOOLEAN',        FALSE, 7, NULL, NULL, 'Identity'),
  (lt_saas_b2c, 'contact_email',    'Contact Email',        'EMAIL',          FALSE, 8, NULL, NULL, 'Contact')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('LIVE','🟢 Live',1),('BETA','🟡 Beta',2),('MVP','🔵 MVP',3),
  ('MONETISED','💰 Monetised',4),('FOR_SALE','🏷️ For Sale',5)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_saas_b2c AND fd.field_key = 'stage'
ON CONFLICT DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('freemium','Freemium',1),('subscription','Subscription',2),
  ('one_time','One-Time Purchase',3),('free','Completely Free',4),
  ('ads','Ad-Supported',5)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_saas_b2c AND fd.field_key = 'pricing_model'
ON CONFLICT DO NOTHING;

-- ── E-COMMERCE STORE ──────────────────────────────────────────────
INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
VALUES
  (lt_ecom_store, 'website_url',       'Store URL',              'URL_PREVIEW',    TRUE,  1, NULL, NULL, 'Live Site'),
  (lt_ecom_store, 'niche',             'Product Niche / Category','SELECT',        TRUE,  2, NULL, NULL, 'Identity'),
  (lt_ecom_store, 'platform',          'Built On',               'SELECT',         TRUE,  3, NULL, 'The platform or framework', 'Tech Stack'),
  (lt_ecom_store, 'tech_stack',        'Additional Tech',        'TECH_STACK',     FALSE, 4, NULL, NULL, 'Tech Stack'),
  (lt_ecom_store, 'monthly_visitors',  'Monthly Visitors',       'METRIC_DISPLAY', FALSE, 5, NULL, NULL, 'Audience & Metrics'),
  (lt_ecom_store, 'monthly_revenue',   'Monthly Revenue (USD)',  'METRIC_DISPLAY', FALSE, 6, NULL, NULL, 'Monetisation'),
  (lt_ecom_store, 'sku_count',         'Number of Products / SKUs','METRIC_DISPLAY',FALSE,7, NULL, NULL, 'Identity'),
  (lt_ecom_store, 'accepts_payments',  'Payment Methods',        'TEXTAREA',       FALSE, 8, 'Visa, M-Pesa, PayPal...', NULL, 'Monetisation'),
  (lt_ecom_store, 'ships_to',          'Ships / Delivers To',    'TEXT',           FALSE, 9, 'Uganda, Kenya, Global...', NULL, 'Identity'),
  (lt_ecom_store, 'stage',             'Status',                 'BADGE',          FALSE, 10,NULL, NULL, 'Identity'),
  (lt_ecom_store, 'html_embed',        'Store Preview HTML',     'HTML_EMBED',     FALSE, 11,NULL, 'Paste product carousel or hero HTML', 'HTML Preview'),
  (lt_ecom_store, 'contact_email',     'Contact Email',          'EMAIL',          FALSE, 12,NULL, NULL, 'Contact')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('fashion','Fashion & Apparel',1),('electronics','Electronics',2),
  ('food','Food & Groceries',3),('beauty','Beauty & Cosmetics',4),
  ('home','Home & Furniture',5),('books','Books & Education',6),
  ('sports','Sports & Fitness',7),('general','General / Mixed',8)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_ecom_store AND fd.field_key = 'niche'
ON CONFLICT DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('shopify','Shopify',1),('woocommerce','WooCommerce',2),
  ('custom','Custom Built',3),('wix','Wix',4),
  ('squarespace','Squarespace',5),('bigcommerce','BigCommerce',6),
  ('prestashop','PrestaShop',7),('other','Other',8)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_ecom_store AND fd.field_key = 'platform'
ON CONFLICT DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('LIVE','🟢 Live & Trading',1),('BETA','🟡 Beta',2),
  ('FOR_SALE','🏷️ For Sale',3),('MONETISED','💰 Profitable',4)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_ecom_store AND fd.field_key = 'stage'
ON CONFLICT DO NOTHING;

-- ── DEVELOPER PORTFOLIO ───────────────────────────────────────────
INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
VALUES
  (lt_portfolio_dev, 'website_url',      'Portfolio URL',          'URL_PREVIEW',    TRUE,  1, NULL, NULL, 'Live Site'),
  (lt_portfolio_dev, 'github_url',       'GitHub Profile',         'URL_PREVIEW',    FALSE, 2, NULL, NULL, 'Live Site'),
  (lt_portfolio_dev, 'specialisation',   'Specialisation',         'SELECT',         TRUE,  3, NULL, NULL, 'Identity'),
  (lt_portfolio_dev, 'experience_years', 'Years of Experience',    'NUMBER',         FALSE, 4, '3', NULL, 'Identity'),
  (lt_portfolio_dev, 'tech_stack',       'Core Tech Stack',        'TECH_STACK',     TRUE,  5, NULL, NULL, 'Tech Stack'),
  (lt_portfolio_dev, 'projects_count',   'Projects Showcased',     'METRIC_DISPLAY', FALSE, 6, NULL, NULL, 'Audience & Metrics'),
  (lt_portfolio_dev, 'available_for',    'Available For',          'SELECT',         FALSE, 7, NULL, NULL, 'Identity'),
  (lt_portfolio_dev, 'html_embed',       'Portfolio Hero HTML',    'HTML_EMBED',     FALSE, 8, NULL, 'Paste your hero section HTML for a live preview', 'HTML Preview'),
  (lt_portfolio_dev, 'code_sample',      'Featured Code Snippet',  'CODE_BLOCK',     FALSE, 9, NULL, 'Show off a clean piece of code', 'HTML Preview'),
  (lt_portfolio_dev, 'contact_email',    'Email / Contact',        'EMAIL',          FALSE, 10,NULL, NULL, 'Contact')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('frontend','Frontend / UI',1),('backend','Backend / API',2),
  ('fullstack','Full Stack',3),('mobile','Mobile (iOS/Android)',4),
  ('devops','DevOps / Cloud',5),('data','Data / ML / AI',6),
  ('blockchain','Blockchain / Web3',7),('game','Game Development',8)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_portfolio_dev AND fd.field_key = 'specialisation'
ON CONFLICT DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('freelance','Freelance Projects',1),('fulltime','Full-Time Roles',2),
  ('contract','Contract Work',3),('consulting','Consulting',4),
  ('collaboration','Open Source / Collaboration',5)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_portfolio_dev AND fd.field_key = 'available_for'
ON CONFLICT DO NOTHING;

-- ── NICHE BLOG ────────────────────────────────────────────────────
INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
VALUES
  (lt_blog_niche, 'website_url',      'Blog URL',              'URL_PREVIEW',    TRUE,  1, NULL, NULL, 'Live Site'),
  (lt_blog_niche, 'niche_topic',      'Blog Topic / Niche',    'TEXT',           TRUE,  2, 'e.g. Personal Finance, Travel Africa', NULL, 'Identity'),
  (lt_blog_niche, 'monthly_visitors', 'Monthly Readers',       'METRIC_DISPLAY', FALSE, 3, NULL, NULL, 'Audience & Metrics'),
  (lt_blog_niche, 'email_subscribers','Email Subscribers',     'METRIC_DISPLAY', FALSE, 4, NULL, NULL, 'Audience & Metrics'),
  (lt_blog_niche, 'articles_count',   'Articles Published',    'METRIC_DISPLAY', FALSE, 5, NULL, NULL, 'Audience & Metrics'),
  (lt_blog_niche, 'monetisation',     'Monetisation Methods',  'TEXTAREA',       FALSE, 6, 'AdSense, sponsored posts, affiliates...', NULL, 'Monetisation'),
  (lt_blog_niche, 'tech_stack',       'Built With',            'TECH_STACK',     FALSE, 7, NULL, NULL, 'Tech Stack'),
  (lt_blog_niche, 'stage',            'Status',                'BADGE',          FALSE, 8, NULL, NULL, 'Identity'),
  (lt_blog_niche, 'contact_email',    'Contact Email',         'EMAIL',          FALSE, 9, NULL, NULL, 'Contact')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('LIVE','🟢 Active',1),('MONETISED','💰 Monetised',2),
  ('FOR_SALE','🏷️ For Sale',3),('BETA','🔵 Growing',4)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_blog_niche AND fd.field_key = 'stage'
ON CONFLICT DO NOTHING;

-- ── ONLINE TOOL (CALCULATOR / GENERATOR / CONVERTER / CHECKER) ────
-- We use the calculator type as template; others get same fields
INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
SELECT lt_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group
FROM (VALUES
  (lt_tool_calculator, 'website_url',      'Tool URL',              'URL_PREVIEW',    TRUE,  1, NULL, NULL, 'Live Site'),
  (lt_tool_calculator, 'tool_purpose',     'What does it do?',      'TEXTAREA',       TRUE,  2, 'Describe the problem this tool solves...', NULL, 'Identity'),
  (lt_tool_calculator, 'tech_stack',       'Built With',            'TECH_STACK',     FALSE, 3, NULL, NULL, 'Tech Stack'),
  (lt_tool_calculator, 'monthly_users',    'Monthly Users',         'METRIC_DISPLAY', FALSE, 4, NULL, NULL, 'Audience & Metrics'),
  (lt_tool_calculator, 'is_free',          'Free to Use',           'BOOLEAN',        FALSE, 5, NULL, NULL, 'Monetisation'),
  (lt_tool_calculator, 'html_embed',       'Live Tool Embed',       'HTML_EMBED',     FALSE, 6, NULL, 'Embed the actual tool HTML — visitors can interact with it', 'HTML Preview'),
  (lt_tool_calculator, 'contact_email',    'Contact',               'EMAIL',          FALSE, 7, NULL, NULL, 'Contact')
) AS t(lt_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
SELECT lt_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group
FROM (VALUES
  (lt_tool_generator, 'website_url',   'Tool URL',          'URL_PREVIEW',TRUE,1,NULL,NULL,'Live Site'),
  (lt_tool_generator, 'tool_purpose',  'What does it do?',  'TEXTAREA',   TRUE,2,NULL,NULL,'Identity'),
  (lt_tool_generator, 'tech_stack',    'Built With',        'TECH_STACK', FALSE,3,NULL,NULL,'Tech Stack'),
  (lt_tool_generator, 'monthly_users', 'Monthly Users',     'METRIC_DISPLAY',FALSE,4,NULL,NULL,'Audience & Metrics'),
  (lt_tool_generator, 'is_free',       'Free to Use',       'BOOLEAN',    FALSE,5,NULL,NULL,'Monetisation'),
  (lt_tool_generator, 'html_embed',    'Live Tool Embed',   'HTML_EMBED', FALSE,6,NULL,'Embed the actual tool HTML',  'HTML Preview'),
  (lt_tool_generator, 'contact_email', 'Contact',           'EMAIL',      FALSE,7,NULL,NULL,'Contact')
) AS t(lt_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
SELECT lt_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group
FROM (VALUES
  (lt_tool_converter, 'website_url',   'Tool URL',          'URL_PREVIEW',TRUE,1,NULL,NULL,'Live Site'),
  (lt_tool_converter, 'tool_purpose',  'What does it do?',  'TEXTAREA',   TRUE,2,NULL,NULL,'Identity'),
  (lt_tool_converter, 'tech_stack',    'Built With',        'TECH_STACK', FALSE,3,NULL,NULL,'Tech Stack'),
  (lt_tool_converter, 'monthly_users', 'Monthly Users',     'METRIC_DISPLAY',FALSE,4,NULL,NULL,'Audience & Metrics'),
  (lt_tool_converter, 'is_free',       'Free to Use',       'BOOLEAN',    FALSE,5,NULL,NULL,'Monetisation'),
  (lt_tool_converter, 'html_embed',    'Live Tool Embed',   'HTML_EMBED', FALSE,6,NULL,'Embed the actual tool HTML', 'HTML Preview'),
  (lt_tool_converter, 'contact_email', 'Contact',           'EMAIL',      FALSE,7,NULL,NULL,'Contact')
) AS t(lt_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
SELECT lt_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group
FROM (VALUES
  (lt_tool_checker, 'website_url',   'Tool URL',          'URL_PREVIEW', TRUE,1,NULL,NULL,'Live Site'),
  (lt_tool_checker, 'tool_purpose',  'What does it do?',  'TEXTAREA',    TRUE,2,NULL,NULL,'Identity'),
  (lt_tool_checker, 'tech_stack',    'Built With',        'TECH_STACK',  FALSE,3,NULL,NULL,'Tech Stack'),
  (lt_tool_checker, 'monthly_users', 'Monthly Users',     'METRIC_DISPLAY',FALSE,4,NULL,NULL,'Audience & Metrics'),
  (lt_tool_checker, 'is_free',       'Free to Use',       'BOOLEAN',     FALSE,5,NULL,NULL,'Monetisation'),
  (lt_tool_checker, 'html_embed',    'Live Tool Embed',   'HTML_EMBED',  FALSE,6,NULL,'Embed the actual tool HTML', 'HTML Preview'),
  (lt_tool_checker, 'contact_email', 'Contact',           'EMAIL',       FALSE,7,NULL,NULL,'Contact')
) AS t(lt_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

-- ── REST API / DEVELOPER PRODUCT ──────────────────────────────────
INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
VALUES
  (lt_api_rest, 'website_url',      'Docs / Product URL',       'URL_PREVIEW',    TRUE,  1, NULL, NULL, 'Live Site'),
  (lt_api_rest, 'github_url',       'GitHub Repository',        'URL_PREVIEW',    FALSE, 2, NULL, NULL, 'Live Site'),
  (lt_api_rest, 'stage',            'Status',                   'BADGE',          TRUE,  3, NULL, NULL, 'Identity'),
  (lt_api_rest, 'is_open_source',   'Open Source',              'BOOLEAN',        FALSE, 4, NULL, NULL, 'Identity'),
  (lt_api_rest, 'pricing_model',    'Pricing',                  'SELECT',         TRUE,  5, NULL, NULL, 'Monetisation'),
  (lt_api_rest, 'tech_stack',       'Tech Stack',               'TECH_STACK',     TRUE,  6, NULL, NULL, 'Tech Stack'),
  (lt_api_rest, 'api_requests',     'API Calls / Month',        'METRIC_DISPLAY', FALSE, 7, NULL, NULL, 'Audience & Metrics'),
  (lt_api_rest, 'active_customers', 'Active Developers / Users','METRIC_DISPLAY', FALSE, 8, NULL, NULL, 'Audience & Metrics'),
  (lt_api_rest, 'code_sample',      'Sample API Request',       'CODE_BLOCK',     FALSE, 9, NULL, 'Show a working curl or code example', 'HTML Preview'),
  (lt_api_rest, 'html_embed',       'Product Page HTML',        'HTML_EMBED',     FALSE, 10,NULL, NULL, 'HTML Preview'),
  (lt_api_rest, 'contact_email',    'Developer Contact',        'EMAIL',          FALSE, 11,NULL, NULL, 'Contact')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('LIVE','🟢 Live',1),('BETA','🟡 Beta',2),('DEPRECATED','⚫ Deprecated',3)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_api_rest AND fd.field_key = 'stage'
ON CONFLICT DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('free_tier','Free Tier Available',1),('pay_per_use','Pay-Per-Use',2),
  ('subscription','Subscription',3),('free','Completely Free',4),
  ('enterprise','Enterprise Only',5)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_api_rest AND fd.field_key = 'pricing_model'
ON CONFLICT DO NOTHING;

-- ── BROWSER GAME ──────────────────────────────────────────────────
INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
VALUES
  (lt_game_browser, 'website_url',      'Game URL',               'URL_PREVIEW',    TRUE,  1, NULL, NULL, 'Live Site'),
  (lt_game_browser, 'genre',            'Game Genre',             'SELECT',         TRUE,  2, NULL, NULL, 'Identity'),
  (lt_game_browser, 'tech_stack',       'Built With',             'TECH_STACK',     FALSE, 3, 'HTML5, Phaser, Unity WebGL…', NULL, 'Tech Stack'),
  (lt_game_browser, 'monthly_players',  'Monthly Players',        'METRIC_DISPLAY', FALSE, 4, NULL, NULL, 'Audience & Metrics'),
  (lt_game_browser, 'is_multiplayer',   'Multiplayer / Online',   'BOOLEAN',        FALSE, 5, NULL, NULL, 'Identity'),
  (lt_game_browser, 'is_free',          'Free to Play',           'BOOLEAN',        FALSE, 6, NULL, NULL, 'Monetisation'),
  (lt_game_browser, 'html_embed',       'Playable Game Embed',    'HTML_EMBED',     FALSE, 7, NULL, 'Paste your game HTML — visitors can play right on the product page!', 'HTML Preview'),
  (lt_game_browser, 'contact_email',    'Contact',                'EMAIL',          FALSE, 8, NULL, NULL, 'Contact')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('action','Action',1),('puzzle','Puzzle',2),('strategy','Strategy',3),
  ('rpg','RPG / Adventure',4),('sports','Sports',5),
  ('casual','Casual / Idle',6),('word','Word / Trivia',7),('other','Other',8)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_game_browser AND fd.field_key = 'genre'
ON CONFLICT DO NOTHING;

-- remaining types (hotel, clinic, school, crm, analytics, marketplace, booking,
-- design portfolio, photo portfolio, news blog, affiliate blog, sdk, data api,
-- puzzle game) use same pattern — minimal fields, no clutter
INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
SELECT lt_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group
FROM (VALUES
  -- Hotel
  (lt_biz_hotel,'website_url','Hotel URL','URL_PREVIEW',TRUE,1,NULL,NULL,'Live Site'),
  (lt_biz_hotel,'star_rating','Star Rating','SELECT',FALSE,2,NULL,NULL,'Identity'),
  (lt_biz_hotel,'room_types','Room Types Available','TEXTAREA',FALSE,3,'Standard, Deluxe, Suite…',NULL,'Identity'),
  (lt_biz_hotel,'tech_stack','Booking System','TECH_STACK',FALSE,4,NULL,NULL,'Tech Stack'),
  (lt_biz_hotel,'monthly_visitors','Monthly Website Visitors','METRIC_DISPLAY',FALSE,5,NULL,NULL,'Audience & Metrics'),
  (lt_biz_hotel,'html_embed','Hero / Booking Widget HTML','HTML_EMBED',FALSE,6,NULL,NULL,'HTML Preview'),
  (lt_biz_hotel,'contact_email','Reservations Email','EMAIL',FALSE,7,NULL,NULL,'Contact'),
  (lt_biz_hotel,'contact_phone','Reservations Phone','PHONE',FALSE,8,NULL,NULL,'Contact'),
  -- Clinic
  (lt_biz_clinic,'website_url','Clinic Website','URL_PREVIEW',TRUE,1,NULL,NULL,'Live Site'),
  (lt_biz_clinic,'specialty','Medical Specialty','TEXT',TRUE,2,'General Practice, Dentistry…',NULL,'Identity'),
  (lt_biz_clinic,'booking_url','Online Booking URL','URL_PREVIEW',FALSE,3,NULL,NULL,'Live Site'),
  (lt_biz_clinic,'tech_stack','Website Platform','TECH_STACK',FALSE,4,NULL,NULL,'Tech Stack'),
  (lt_biz_clinic,'html_embed','Homepage Preview HTML','HTML_EMBED',FALSE,5,NULL,NULL,'HTML Preview'),
  (lt_biz_clinic,'contact_email','Email','EMAIL',FALSE,6,NULL,NULL,'Contact'),
  (lt_biz_clinic,'contact_phone','Phone','PHONE',FALSE,7,NULL,NULL,'Contact'),
  -- School
  (lt_biz_school,'website_url','School Website','URL_PREVIEW',TRUE,1,NULL,NULL,'Live Site'),
  (lt_biz_school,'education_level','Education Level','SELECT',TRUE,2,NULL,NULL,'Identity'),
  (lt_biz_school,'enrollment_count','Enrolled Students','METRIC_DISPLAY',FALSE,3,NULL,NULL,'Audience & Metrics'),
  (lt_biz_school,'tech_stack','LMS / Platform','TECH_STACK',FALSE,4,NULL,NULL,'Tech Stack'),
  (lt_biz_school,'html_embed','School Page Preview HTML','HTML_EMBED',FALSE,5,NULL,NULL,'HTML Preview'),
  (lt_biz_school,'contact_email','Admissions Email','EMAIL',FALSE,6,NULL,NULL,'Contact'),
  -- CRM / Project Tool
  (lt_saas_crm,'website_url','Product URL','URL_PREVIEW',TRUE,1,NULL,NULL,'Live Site'),
  (lt_saas_crm,'stage','Stage','BADGE',TRUE,2,NULL,NULL,'Identity'),
  (lt_saas_crm,'pricing_model','Pricing','SELECT',TRUE,3,NULL,NULL,'Monetisation'),
  (lt_saas_crm,'active_customers','Active Teams / Users','METRIC_DISPLAY',FALSE,4,NULL,NULL,'Audience & Metrics'),
  (lt_saas_crm,'tech_stack','Tech Stack','TECH_STACK',FALSE,5,NULL,NULL,'Tech Stack'),
  (lt_saas_crm,'html_embed','Product Demo HTML','HTML_EMBED',FALSE,6,NULL,NULL,'HTML Preview'),
  (lt_saas_crm,'code_sample','API / Integration Sample','CODE_BLOCK',FALSE,7,NULL,NULL,'HTML Preview'),
  -- Analytics / Dashboard
  (lt_saas_analytics,'website_url','Product URL','URL_PREVIEW',TRUE,1,NULL,NULL,'Live Site'),
  (lt_saas_analytics,'stage','Stage','BADGE',TRUE,2,NULL,NULL,'Identity'),
  (lt_saas_analytics,'pricing_model','Pricing','SELECT',TRUE,3,NULL,NULL,'Monetisation'),
  (lt_saas_analytics,'active_customers','Active Users','METRIC_DISPLAY',FALSE,4,NULL,NULL,'Audience & Metrics'),
  (lt_saas_analytics,'tech_stack','Tech Stack','TECH_STACK',FALSE,5,NULL,NULL,'Tech Stack'),
  (lt_saas_analytics,'html_embed','Dashboard Preview HTML','HTML_EMBED',FALSE,6,NULL,NULL,'HTML Preview'),
  -- Marketplace
  (lt_ecom_market,'website_url','Marketplace URL','URL_PREVIEW',TRUE,1,NULL,NULL,'Live Site'),
  (lt_ecom_market,'tech_stack','Built With','TECH_STACK',FALSE,2,NULL,NULL,'Tech Stack'),
  (lt_ecom_market,'monthly_visitors','Monthly Visitors','METRIC_DISPLAY',FALSE,3,NULL,NULL,'Audience & Metrics'),
  (lt_ecom_market,'vendor_count','Active Vendors','METRIC_DISPLAY',FALSE,4,NULL,NULL,'Audience & Metrics'),
  (lt_ecom_market,'stage','Status','BADGE',FALSE,5,NULL,NULL,'Identity'),
  (lt_ecom_market,'html_embed','Marketplace Preview HTML','HTML_EMBED',FALSE,6,NULL,NULL,'HTML Preview'),
  (lt_ecom_market,'contact_email','Contact Email','EMAIL',FALSE,7,NULL,NULL,'Contact'),
  -- Booking Site
  (lt_ecom_booking,'website_url','Booking Site URL','URL_PREVIEW',TRUE,1,NULL,NULL,'Live Site'),
  (lt_ecom_booking,'booking_niche','Booking Category','TEXT',TRUE,2,'Hotels, Events, Clinics…',NULL,'Identity'),
  (lt_ecom_booking,'tech_stack','Built With','TECH_STACK',FALSE,3,NULL,NULL,'Tech Stack'),
  (lt_ecom_booking,'monthly_visitors','Monthly Bookings','METRIC_DISPLAY',FALSE,4,NULL,NULL,'Audience & Metrics'),
  (lt_ecom_booking,'html_embed','Booking Widget HTML','HTML_EMBED',FALSE,5,NULL,'Embed your booking calendar or widget',  'HTML Preview'),
  (lt_ecom_booking,'contact_email','Contact Email','EMAIL',FALSE,6,NULL,NULL,'Contact'),
  -- Design Portfolio
  (lt_portfolio_design,'website_url','Portfolio URL','URL_PREVIEW',TRUE,1,NULL,NULL,'Live Site'),
  (lt_portfolio_design,'specialisation','Design Focus','SELECT',TRUE,2,NULL,NULL,'Identity'),
  (lt_portfolio_design,'tech_stack','Built With','TECH_STACK',FALSE,3,NULL,NULL,'Tech Stack'),
  (lt_portfolio_design,'projects_count','Projects Shown','METRIC_DISPLAY',FALSE,4,NULL,NULL,'Audience & Metrics'),
  (lt_portfolio_design,'html_embed','Portfolio Preview HTML','HTML_EMBED',FALSE,5,NULL,NULL,'HTML Preview'),
  (lt_portfolio_design,'contact_email','Contact Email','EMAIL',FALSE,6,NULL,NULL,'Contact'),
  -- Photo Portfolio
  (lt_portfolio_photo,'website_url','Portfolio URL','URL_PREVIEW',TRUE,1,NULL,NULL,'Live Site'),
  (lt_portfolio_photo,'photography_niche','Photography Style','TEXT',TRUE,2,'Wedding, Events, Commercial…',NULL,'Identity'),
  (lt_portfolio_photo,'tech_stack','Built With','TECH_STACK',FALSE,3,NULL,NULL,'Tech Stack'),
  (lt_portfolio_photo,'html_embed','Gallery Preview HTML','HTML_EMBED',FALSE,4,NULL,NULL,'HTML Preview'),
  (lt_portfolio_photo,'contact_email','Contact Email','EMAIL',FALSE,5,NULL,NULL,'Contact'),
  -- News Blog
  (lt_blog_news,'website_url','Publication URL','URL_PREVIEW',TRUE,1,NULL,NULL,'Live Site'),
  (lt_blog_news,'coverage_area','Coverage / Beat','TEXT',TRUE,2,'Uganda Politics, African Tech…',NULL,'Identity'),
  (lt_blog_news,'monthly_visitors','Monthly Readers','METRIC_DISPLAY',FALSE,3,NULL,NULL,'Audience & Metrics'),
  (lt_blog_news,'tech_stack','CMS / Platform','TECH_STACK',FALSE,4,NULL,NULL,'Tech Stack'),
  (lt_blog_news,'contact_email','Editor Email','EMAIL',FALSE,5,NULL,NULL,'Contact'),
  -- Affiliate Blog
  (lt_blog_affiliate,'website_url','Blog URL','URL_PREVIEW',TRUE,1,NULL,NULL,'Live Site'),
  (lt_blog_affiliate,'niche_topic','Niche Topic','TEXT',TRUE,2,NULL,NULL,'Identity'),
  (lt_blog_affiliate,'monthly_visitors','Monthly Visitors','METRIC_DISPLAY',FALSE,3,NULL,NULL,'Audience & Metrics'),
  (lt_blog_affiliate,'monthly_revenue','Monthly Affiliate Revenue (USD)','METRIC_DISPLAY',FALSE,4,NULL,NULL,'Monetisation'),
  (lt_blog_affiliate,'tech_stack','Built With','TECH_STACK',FALSE,5,NULL,NULL,'Tech Stack'),
  (lt_blog_affiliate,'stage','Status','BADGE',FALSE,6,NULL,NULL,'Identity'),
  (lt_blog_affiliate,'contact_email','Contact Email','EMAIL',FALSE,7,NULL,NULL,'Contact'),
  -- SDK / Library
  (lt_api_sdk,'website_url','Docs / NPM / PyPI URL','URL_PREVIEW',TRUE,1,NULL,NULL,'Live Site'),
  (lt_api_sdk,'github_url','GitHub Repo','URL_PREVIEW',FALSE,2,NULL,NULL,'Live Site'),
  (lt_api_sdk,'is_open_source','Open Source','BOOLEAN',FALSE,3,NULL,NULL,'Identity'),
  (lt_api_sdk,'tech_stack','Language / Runtime','TECH_STACK',TRUE,4,NULL,NULL,'Tech Stack'),
  (lt_api_sdk,'active_customers','Downloads / Stars','METRIC_DISPLAY',FALSE,5,NULL,NULL,'Audience & Metrics'),
  (lt_api_sdk,'code_sample','Installation & Quick Start','CODE_BLOCK',FALSE,6,NULL,'npm install / pip install example',  'HTML Preview'),
  (lt_api_sdk,'contact_email','Maintainer Email','EMAIL',FALSE,7,NULL,NULL,'Contact'),
  -- Data / Dataset Product
  (lt_api_data,'website_url','Product / Docs URL','URL_PREVIEW',TRUE,1,NULL,NULL,'Live Site'),
  (lt_api_data,'data_description','What data is provided?','TEXTAREA',TRUE,2,NULL,NULL,'Identity'),
  (lt_api_data,'data_format','Data Format','SELECT',TRUE,3,NULL,NULL,'Technical'),
  (lt_api_data,'update_frequency','Update Frequency','SELECT',FALSE,4,NULL,NULL,'Technical'),
  (lt_api_data,'pricing_model','Pricing','SELECT',TRUE,5,NULL,NULL,'Monetisation'),
  (lt_api_data,'record_count','Records / Rows Available','METRIC_DISPLAY',FALSE,6,NULL,NULL,'Technical'),
  (lt_api_data,'tech_stack','Tech Stack','TECH_STACK',FALSE,7,NULL,NULL,'Tech Stack'),
  (lt_api_data,'contact_email','Contact Email','EMAIL',FALSE,8,NULL,NULL,'Contact'),
  -- Puzzle Game
  (lt_game_puzzle,'website_url','Game URL','URL_PREVIEW',TRUE,1,NULL,NULL,'Live Site'),
  (lt_game_puzzle,'tech_stack','Built With','TECH_STACK',FALSE,2,NULL,NULL,'Tech Stack'),
  (lt_game_puzzle,'monthly_players','Monthly Players','METRIC_DISPLAY',FALSE,3,NULL,NULL,'Audience & Metrics'),
  (lt_game_puzzle,'is_free','Free to Play','BOOLEAN',FALSE,4,NULL,NULL,'Monetisation'),
  (lt_game_puzzle,'html_embed','Playable Game Embed','HTML_EMBED',FALSE,5,NULL,'Paste game HTML — visitors can play right here', 'HTML Preview'),
  (lt_game_puzzle,'contact_email','Contact','EMAIL',FALSE,6,NULL,NULL,'Contact')
) AS t(lt_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

-- Options for remaining selects
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('1','1 Star',1),('2','2 Stars',2),('3','3 Stars',3),
  ('4','4 Stars',4),('5','5 Stars',5)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_biz_hotel AND fd.field_key = 'star_rating'
ON CONFLICT DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('nursery','Nursery / Pre-School',1),('primary','Primary',2),
  ('secondary','Secondary / High School',3),('tertiary','University / College',4),
  ('vocational','Vocational / Skills',5),('online','Online / E-Learning',6)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_biz_school AND fd.field_key = 'education_level'
ON CONFLICT DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('freemium','Freemium',1),('subscription','Subscription',2),
  ('one_time','One-Time',3),('free','Free',4),('enterprise','Enterprise',5)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id IN (lt_saas_crm, lt_saas_analytics) AND fd.field_key = 'pricing_model'
ON CONFLICT DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('LIVE','🟢 Live',1),('BETA','🟡 Beta',2),('MVP','🔵 MVP',3),
  ('MONETISED','💰 Monetised',4),('FOR_SALE','🏷️ For Sale',5)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id IN (lt_saas_crm, lt_saas_analytics, lt_ecom_market,
  lt_blog_affiliate) AND fd.field_key = 'stage'
ON CONFLICT DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('ui_ux','UI / UX Design',1),('graphic','Graphic Design',2),
  ('brand','Brand Identity',3),('motion','Motion / Animation',4),
  ('illustration','Illustration',5)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_portfolio_design AND fd.field_key = 'specialisation'
ON CONFLICT DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('json','JSON',1),('csv','CSV / Excel',2),('xml','XML',3),
  ('api','REST API Stream',4),('sql','SQL Dump',5),('other','Other',6)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_api_data AND fd.field_key = 'data_format'
ON CONFLICT DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('real_time','Real-Time',1),('daily','Daily',2),('weekly','Weekly',3),
  ('monthly','Monthly',4),('static','Static / One-Time',5)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_api_data AND fd.field_key = 'update_frequency'
ON CONFLICT DO NOTHING;

INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT fd.id, v.val, v.lbl, v.ord FROM advert_field_definitions fd
JOIN (VALUES
  ('free_tier','Free Tier',1),('pay_per_use','Pay-Per-Use',2),
  ('subscription','Subscription',3),('free','Free / Open',4),
  ('enterprise','Enterprise',5)
) AS v(val,lbl,ord) ON TRUE
WHERE fd.listing_type_id = lt_api_data AND fd.field_key = 'pricing_model'
ON CONFLICT DO NOTHING;

END $$;
