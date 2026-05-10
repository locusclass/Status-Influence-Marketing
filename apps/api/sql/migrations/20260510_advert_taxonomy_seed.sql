-- Advert Taxonomy Seed
-- Categories, subcategories, listing types, and field definitions
-- Powered by Shopify taxonomy patterns + Prime Status custom extensions

DO $$
DECLARE
  -- Categories
  cat_vehicle          UUID;
  cat_real_estate      UUID;
  cat_electronics      UUID;
  cat_event            UUID;
  cat_job              UUID;
  cat_service          UUID;
  cat_fashion          UUID;
  cat_food             UUID;
  cat_education        UUID;
  cat_healthcare       UUID;
  cat_agriculture      UUID;
  cat_tourism          UUID;
  cat_finance          UUID;
  cat_entertainment    UUID;
  cat_announcement     UUID;
  cat_ngo              UUID;
  cat_religious        UUID;
  cat_sports           UUID;
  cat_digital          UUID;
  cat_industrial       UUID;
  cat_telecom          UUID;
  cat_pets             UUID;
  cat_creative         UUID;
  cat_auto_service     UUID;
  cat_government       UUID;

  -- Subcategories (Vehicle)
  sub_cars             UUID;
  sub_motorcycles      UUID;
  sub_trucks           UUID;
  sub_buses            UUID;
  sub_vans             UUID;

  -- Subcategories (Real Estate)
  sub_re_rental        UUID;
  sub_re_sale          UUID;
  sub_re_commercial    UUID;
  sub_re_shortstay     UUID;

  -- Subcategories (Electronics)
  sub_phones           UUID;
  sub_computers        UUID;
  sub_tv               UUID;
  sub_accessories      UUID;
  sub_appliances       UUID;

  -- Subcategories (Fashion & Beauty)
  sub_clothing         UUID;
  sub_shoes            UUID;
  sub_bags             UUID;
  sub_beauty           UUID;
  sub_jewellery        UUID;

  -- Subcategories (Food)
  sub_restaurant       UUID;
  sub_catering         UUID;
  sub_grocery          UUID;
  sub_bakery           UUID;

  -- Subcategories (Jobs)
  sub_fulltime         UUID;
  sub_parttime         UUID;
  sub_contract         UUID;
  sub_internship       UUID;

  -- Subcategories (Events)
  sub_concert          UUID;
  sub_conference       UUID;
  sub_wedding          UUID;
  sub_sport_event      UUID;
  sub_festival         UUID;

  -- Listing types (Cars)
  lt_suv               UUID;
  lt_sedan             UUID;
  lt_hatchback         UUID;
  lt_pickup            UUID;
  lt_coupe             UUID;

  -- Listing types (Motorcycles)
  lt_sport_bike        UUID;
  lt_cruiser           UUID;
  lt_scooter           UUID;
  lt_bodaboda          UUID;

  -- Listing types (Phones)
  lt_iphone            UUID;
  lt_samsung           UUID;
  lt_tecno             UUID;
  lt_infinix           UUID;
  lt_other_phone       UUID;

  -- Listing types (Real Estate Rental)
  lt_apartment         UUID;
  lt_hostel            UUID;
  lt_shop              UUID;
  lt_office            UUID;
  lt_land              UUID;

  -- Listing types (Real Estate Sale)
  lt_house_sale        UUID;
  lt_land_sale         UUID;
  lt_apartment_sale    UUID;
  lt_commercial_sale   UUID;

  -- Listing types (Clothing)
  lt_mens_wear         UUID;
  lt_womens_wear       UUID;
  lt_kids_wear         UUID;
  lt_unisex            UUID;

  -- Listing types (Events)
  lt_concert_event     UUID;
  lt_conf_event        UUID;
  lt_wedding_event     UUID;
  lt_festival_event    UUID;

  -- Listing types (Jobs)
  lt_tech_job          UUID;
  lt_finance_job       UUID;
  lt_sales_job         UUID;
  lt_hospitality_job   UUID;
  lt_general_job       UUID;

  -- Listing types (Services)
  sub_home_service     UUID;
  sub_professional     UUID;
  sub_transport        UUID;
  lt_cleaning          UUID;
  lt_repair            UUID;
  lt_legal             UUID;
  lt_accounting        UUID;
  lt_logistics         UUID;

  -- Field defs
  fd_title             UUID;
  fd_price             UUID;
  fd_neg               UUID;
  fd_desc              UUID;
  fd_make              UUID;
  fd_model             UUID;
  fd_year              UUID;
  fd_mileage           UUID;
  fd_fuel              UUID;
  fd_trans             UUID;
  fd_color             UUID;
  fd_cond              UUID;
  fd_loc               UUID;
  fd_bedrooms          UUID;
  fd_bathrooms         UUID;
  fd_size              UUID;
  fd_furnished         UUID;
  fd_pet_friendly      UUID;
  fd_storage           UUID;
  fd_ram               UUID;
  fd_battery           UUID;
  fd_screen            UUID;
  fd_event_date        UUID;
  fd_event_venue       UUID;
  fd_event_time        UUID;
  fd_ticket_price      UUID;
  fd_job_salary        UUID;
  fd_job_type          UUID;
  fd_job_exp           UUID;
  fd_job_edu           UUID;
  fd_brand             UUID;
  fd_size_clothing     UUID;
  fd_material          UUID;
  fd_cuisine           UUID;
  fd_menu_url          UUID;
  fd_opening_hours     UUID;
  fd_delivery          UUID;
  fd_phone             UUID;
  fd_email             UUID;
  fd_website           UUID;
  fd_whatsapp          UUID;
  fd_parking           UUID;
  fd_engine            UUID;
  fd_doors             UUID;
  fd_seats             UUID;
  fd_drive_type        UUID;
  fd_body_type         UUID;
BEGIN

-- ─────────────────────────────────────────────
-- INSERT CATEGORIES
-- ─────────────────────────────────────────────

INSERT INTO advert_categories (slug, name, icon, sort_order) VALUES
  ('vehicle',         'Vehicle',                 '🚗', 1),
  ('real-estate',     'Real Estate',             '🏠', 2),
  ('electronics',     'Electronics',             '📱', 3),
  ('event',           'Event',                   '🎉', 4),
  ('job',             'Job Opportunity',         '💼', 5),
  ('service',         'Service',                 '🔧', 6),
  ('fashion-beauty',  'Fashion & Beauty',        '👗', 7),
  ('food',            'Food & Restaurant',       '🍽️', 8),
  ('education',       'Education',               '📚', 9),
  ('healthcare',      'Healthcare',              '🏥', 10),
  ('agriculture',     'Agriculture',             '🌾', 11),
  ('tourism',         'Tourism & Hospitality',   '✈️', 12),
  ('finance',         'Financial Service',       '💰', 13),
  ('entertainment',   'Entertainment & Media',   '🎬', 14),
  ('announcement',    'Public Announcement',     '📢', 15),
  ('ngo',             'NGO & Fundraising',       '❤️', 16),
  ('religious',       'Religious Organization',  '🙏', 17),
  ('sports',          'Sports & Fitness',        '⚽', 18),
  ('digital',         'Digital Product',         '💻', 19),
  ('industrial',      'Industrial & Construction','🏗️', 20),
  ('telecom',         'Telecommunication',       '📡', 21),
  ('pets',            'Pet & Animal',            '🐾', 22),
  ('creative',        'Creative & Art',          '🎨', 23),
  ('auto-service',    'Automotive Service',      '🔩', 24),
  ('government',      'Government & Civic',      '🏛️', 25)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO cat_vehicle      FROM advert_categories WHERE slug = 'vehicle';
SELECT id INTO cat_real_estate  FROM advert_categories WHERE slug = 'real-estate';
SELECT id INTO cat_electronics  FROM advert_categories WHERE slug = 'electronics';
SELECT id INTO cat_event        FROM advert_categories WHERE slug = 'event';
SELECT id INTO cat_job          FROM advert_categories WHERE slug = 'job';
SELECT id INTO cat_service      FROM advert_categories WHERE slug = 'service';
SELECT id INTO cat_fashion      FROM advert_categories WHERE slug = 'fashion-beauty';
SELECT id INTO cat_food         FROM advert_categories WHERE slug = 'food';

-- ─────────────────────────────────────────────
-- VEHICLE SUBCATEGORIES
-- ─────────────────────────────────────────────

INSERT INTO advert_subcategories (category_id, slug, name, sort_order) VALUES
  (cat_vehicle, 'vehicle-cars',        'Cars',        1),
  (cat_vehicle, 'vehicle-motorcycles', 'Motorcycles', 2),
  (cat_vehicle, 'vehicle-trucks',      'Trucks',      3),
  (cat_vehicle, 'vehicle-buses',       'Buses',       4),
  (cat_vehicle, 'vehicle-vans',        'Vans',        5)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO sub_cars        FROM advert_subcategories WHERE slug = 'vehicle-cars';
SELECT id INTO sub_motorcycles FROM advert_subcategories WHERE slug = 'vehicle-motorcycles';

-- ─────────────────────────────────────────────
-- REAL ESTATE SUBCATEGORIES
-- ─────────────────────────────────────────────

INSERT INTO advert_subcategories (category_id, slug, name, sort_order) VALUES
  (cat_real_estate, 're-rental',    'Rental',     1),
  (cat_real_estate, 're-sale',      'For Sale',   2),
  (cat_real_estate, 're-commercial','Commercial', 3),
  (cat_real_estate, 're-shortstay', 'Short Stay', 4)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO sub_re_rental   FROM advert_subcategories WHERE slug = 're-rental';
SELECT id INTO sub_re_sale     FROM advert_subcategories WHERE slug = 're-sale';

-- ─────────────────────────────────────────────
-- ELECTRONICS SUBCATEGORIES
-- ─────────────────────────────────────────────

INSERT INTO advert_subcategories (category_id, slug, name, sort_order) VALUES
  (cat_electronics, 'elec-phones',      'Phones',      1),
  (cat_electronics, 'elec-computers',   'Computers',   2),
  (cat_electronics, 'elec-tv',          'TVs & Audio', 3),
  (cat_electronics, 'elec-accessories', 'Accessories', 4),
  (cat_electronics, 'elec-appliances',  'Appliances',  5)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO sub_phones    FROM advert_subcategories WHERE slug = 'elec-phones';
SELECT id INTO sub_computers FROM advert_subcategories WHERE slug = 'elec-computers';

-- ─────────────────────────────────────────────
-- FASHION SUBCATEGORIES
-- ─────────────────────────────────────────────

INSERT INTO advert_subcategories (category_id, slug, name, sort_order) VALUES
  (cat_fashion, 'fashion-clothing',  'Clothing',   1),
  (cat_fashion, 'fashion-shoes',     'Shoes',      2),
  (cat_fashion, 'fashion-bags',      'Bags',       3),
  (cat_fashion, 'fashion-beauty',    'Beauty',     4),
  (cat_fashion, 'fashion-jewellery', 'Jewellery',  5)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO sub_clothing FROM advert_subcategories WHERE slug = 'fashion-clothing';

-- ─────────────────────────────────────────────
-- FOOD SUBCATEGORIES
-- ─────────────────────────────────────────────

INSERT INTO advert_subcategories (category_id, slug, name, sort_order) VALUES
  (cat_food, 'food-restaurant', 'Restaurant', 1),
  (cat_food, 'food-catering',   'Catering',   2),
  (cat_food, 'food-grocery',    'Grocery',    3),
  (cat_food, 'food-bakery',     'Bakery',     4)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO sub_restaurant FROM advert_subcategories WHERE slug = 'food-restaurant';

-- ─────────────────────────────────────────────
-- JOB SUBCATEGORIES
-- ─────────────────────────────────────────────

INSERT INTO advert_subcategories (category_id, slug, name, sort_order) VALUES
  (cat_job, 'job-fulltime',    'Full-Time',    1),
  (cat_job, 'job-parttime',    'Part-Time',    2),
  (cat_job, 'job-contract',    'Contract',     3),
  (cat_job, 'job-internship',  'Internship',   4)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO sub_fulltime FROM advert_subcategories WHERE slug = 'job-fulltime';

-- ─────────────────────────────────────────────
-- EVENT SUBCATEGORIES
-- ─────────────────────────────────────────────

INSERT INTO advert_subcategories (category_id, slug, name, sort_order) VALUES
  (cat_event, 'event-concert',    'Concert',      1),
  (cat_event, 'event-conference', 'Conference',   2),
  (cat_event, 'event-wedding',    'Wedding',      3),
  (cat_event, 'event-sport',      'Sports Event', 4),
  (cat_event, 'event-festival',   'Festival',     5)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO sub_concert    FROM advert_subcategories WHERE slug = 'event-concert';
SELECT id INTO sub_conference FROM advert_subcategories WHERE slug = 'event-conference';

-- ─────────────────────────────────────────────
-- SERVICE SUBCATEGORIES
-- ─────────────────────────────────────────────

INSERT INTO advert_subcategories (category_id, slug, name, sort_order) VALUES
  (cat_service, 'svc-home',         'Home Services',     1),
  (cat_service, 'svc-professional', 'Professional',      2),
  (cat_service, 'svc-transport',    'Transport',         3)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO sub_home_service FROM advert_subcategories WHERE slug = 'svc-home';
SELECT id INTO sub_professional FROM advert_subcategories WHERE slug = 'svc-professional';

-- ─────────────────────────────────────────────
-- LISTING TYPES: CARS
-- ─────────────────────────────────────────────

INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order) VALUES
  (sub_cars, 'car-suv',       'SUV',       1),
  (sub_cars, 'car-sedan',     'Sedan',     2),
  (sub_cars, 'car-hatchback', 'Hatchback', 3),
  (sub_cars, 'car-pickup',    'Pickup',    4),
  (sub_cars, 'car-coupe',     'Coupe',     5),
  (sub_cars, 'car-station',   'Station Wagon', 6),
  (sub_cars, 'car-other',     'Other',     7)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO lt_suv      FROM advert_listing_types WHERE slug = 'car-suv';
SELECT id INTO lt_sedan    FROM advert_listing_types WHERE slug = 'car-sedan';
SELECT id INTO lt_hatchback FROM advert_listing_types WHERE slug = 'car-hatchback';
SELECT id INTO lt_pickup   FROM advert_listing_types WHERE slug = 'car-pickup';

-- ─────────────────────────────────────────────
-- LISTING TYPES: MOTORCYCLES
-- ─────────────────────────────────────────────

INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order) VALUES
  (sub_motorcycles, 'moto-sport',    'Sport Bike',  1),
  (sub_motorcycles, 'moto-cruiser',  'Cruiser',     2),
  (sub_motorcycles, 'moto-scooter',  'Scooter',     3),
  (sub_motorcycles, 'moto-bodaboda', 'Boda Boda',   4),
  (sub_motorcycles, 'moto-other',    'Other',       5)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO lt_bodaboda FROM advert_listing_types WHERE slug = 'moto-bodaboda';

-- ─────────────────────────────────────────────
-- LISTING TYPES: PHONES
-- ─────────────────────────────────────────────

INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order) VALUES
  (sub_phones, 'phone-iphone',   'iPhone',   1),
  (sub_phones, 'phone-samsung',  'Samsung',  2),
  (sub_phones, 'phone-tecno',    'Tecno',    3),
  (sub_phones, 'phone-infinix',  'Infinix',  4),
  (sub_phones, 'phone-itel',     'Itel',     5),
  (sub_phones, 'phone-xiaomi',   'Xiaomi',   6),
  (sub_phones, 'phone-other',    'Other',    7)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO lt_iphone  FROM advert_listing_types WHERE slug = 'phone-iphone';
SELECT id INTO lt_samsung FROM advert_listing_types WHERE slug = 'phone-samsung';
SELECT id INTO lt_tecno   FROM advert_listing_types WHERE slug = 'phone-tecno';
SELECT id INTO lt_infinix FROM advert_listing_types WHERE slug = 'phone-infinix';
SELECT id INTO lt_other_phone FROM advert_listing_types WHERE slug = 'phone-other';

-- ─────────────────────────────────────────────
-- LISTING TYPES: REAL ESTATE RENTAL
-- ─────────────────────────────────────────────

INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order) VALUES
  (sub_re_rental, 're-rent-apartment', 'Apartment',     1),
  (sub_re_rental, 're-rent-hostel',    'Hostel',        2),
  (sub_re_rental, 're-rent-shop',      'Shop',          3),
  (sub_re_rental, 're-rent-office',    'Office Space',  4),
  (sub_re_rental, 're-rent-house',     'House',         5),
  (sub_re_rental, 're-rent-land',      'Land',          6),
  (sub_re_rental, 're-rent-other',     'Other',         7)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO lt_apartment FROM advert_listing_types WHERE slug = 're-rent-apartment';
SELECT id INTO lt_hostel    FROM advert_listing_types WHERE slug = 're-rent-hostel';
SELECT id INTO lt_shop      FROM advert_listing_types WHERE slug = 're-rent-shop';
SELECT id INTO lt_office    FROM advert_listing_types WHERE slug = 're-rent-office';

-- ─────────────────────────────────────────────
-- LISTING TYPES: REAL ESTATE SALE
-- ─────────────────────────────────────────────

INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order) VALUES
  (sub_re_sale, 're-sale-house',      'House',       1),
  (sub_re_sale, 're-sale-land',       'Land',        2),
  (sub_re_sale, 're-sale-apartment',  'Apartment',   3),
  (sub_re_sale, 're-sale-commercial', 'Commercial',  4),
  (sub_re_sale, 're-sale-other',      'Other',       5)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO lt_house_sale FROM advert_listing_types WHERE slug = 're-sale-house';
SELECT id INTO lt_land_sale  FROM advert_listing_types WHERE slug = 're-sale-land';

-- ─────────────────────────────────────────────
-- LISTING TYPES: CLOTHING
-- ─────────────────────────────────────────────

INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order) VALUES
  (sub_clothing, 'cloth-mens',   'Men''s Wear',   1),
  (sub_clothing, 'cloth-womens', 'Women''s Wear', 2),
  (sub_clothing, 'cloth-kids',   'Kids'' Wear',   3),
  (sub_clothing, 'cloth-unisex', 'Unisex',        4)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO lt_mens_wear   FROM advert_listing_types WHERE slug = 'cloth-mens';
SELECT id INTO lt_womens_wear FROM advert_listing_types WHERE slug = 'cloth-womens';

-- ─────────────────────────────────────────────
-- LISTING TYPES: EVENTS
-- ─────────────────────────────────────────────

INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order) VALUES
  (sub_concert,    'event-type-concert',   'Live Concert',     1),
  (sub_concert,    'event-type-club',      'Club Night',       2),
  (sub_conference, 'event-type-seminar',   'Seminar',          1),
  (sub_conference, 'event-type-workshop',  'Workshop',         2),
  (sub_conference, 'event-type-summit',    'Summit',           3)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO lt_concert_event FROM advert_listing_types WHERE slug = 'event-type-concert';
SELECT id INTO lt_conf_event    FROM advert_listing_types WHERE slug = 'event-type-seminar';

-- ─────────────────────────────────────────────
-- LISTING TYPES: JOBS
-- ─────────────────────────────────────────────

INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order) VALUES
  (sub_fulltime, 'job-tech',         'Technology',       1),
  (sub_fulltime, 'job-finance-role', 'Finance',          2),
  (sub_fulltime, 'job-sales',        'Sales & Marketing',3),
  (sub_fulltime, 'job-hospitality',  'Hospitality',      4),
  (sub_fulltime, 'job-general',      'General',          5)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO lt_tech_job        FROM advert_listing_types WHERE slug = 'job-tech';
SELECT id INTO lt_general_job     FROM advert_listing_types WHERE slug = 'job-general';

-- ─────────────────────────────────────────────
-- LISTING TYPES: HOME SERVICES
-- ─────────────────────────────────────────────

INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order) VALUES
  (sub_home_service, 'svc-cleaning',  'Cleaning',    1),
  (sub_home_service, 'svc-repair',    'Repair',      2),
  (sub_home_service, 'svc-plumbing',  'Plumbing',    3),
  (sub_home_service, 'svc-electric',  'Electrical',  4),
  (sub_professional, 'svc-legal',     'Legal',       1),
  (sub_professional, 'svc-accounts',  'Accounting',  2),
  (sub_professional, 'svc-consult',   'Consulting',  3)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO lt_cleaning  FROM advert_listing_types WHERE slug = 'svc-cleaning';
SELECT id INTO lt_repair    FROM advert_listing_types WHERE slug = 'svc-repair';
SELECT id INTO lt_legal     FROM advert_listing_types WHERE slug = 'svc-legal';
SELECT id INTO lt_accounting FROM advert_listing_types WHERE slug = 'svc-accounts';

-- ─────────────────────────────────────────────
-- FIELD DEFINITIONS: VEHICLE (Cars)
-- ─────────────────────────────────────────────

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
VALUES
  (lt_suv,    'make',       'Make / Brand',       'SELECT',  TRUE,  1,  NULL,        'e.g. Toyota, Nissan',   'Vehicle Details'),
  (lt_suv,    'model',      'Model',               'TEXT',    TRUE,  2,  'e.g. Rav4', NULL,                   'Vehicle Details'),
  (lt_suv,    'year',       'Year',                'NUMBER',  TRUE,  3,  'e.g. 2020', NULL,                   'Vehicle Details'),
  (lt_suv,    'mileage',    'Mileage (km)',         'NUMBER',  FALSE, 4,  NULL,        NULL,                   'Vehicle Details'),
  (lt_suv,    'fuel_type',  'Fuel Type',           'SELECT',  TRUE,  5,  NULL,        NULL,                   'Vehicle Details'),
  (lt_suv,    'transmission','Transmission',       'SELECT',  TRUE,  6,  NULL,        NULL,                   'Vehicle Details'),
  (lt_suv,    'engine_size','Engine (cc)',          'NUMBER',  FALSE, 7,  'e.g. 2000', NULL,                   'Vehicle Details'),
  (lt_suv,    'color',      'Color',               'TEXT',    FALSE, 8,  NULL,        NULL,                   'Vehicle Details'),
  (lt_suv,    'condition',  'Condition',           'SELECT',  TRUE,  9,  NULL,        NULL,                   'Condition'),
  (lt_suv,    'drive_type', 'Drive Type',          'SELECT',  FALSE, 10, NULL,        NULL,                   'Vehicle Details'),
  (lt_suv,    'doors',      'Number of Doors',     'SELECT',  FALSE, 11, NULL,        NULL,                   'Vehicle Details'),
  (lt_suv,    'seats',      'Number of Seats',     'NUMBER',  FALSE, 12, 'e.g. 5',   NULL,                   'Vehicle Details'),
  (lt_suv,    'price',      'Asking Price (UGX)',  'CURRENCY',TRUE,  13, NULL,        NULL,                   'Pricing'),
  (lt_suv,    'negotiable', 'Is Price Negotiable?','BOOLEAN', FALSE, 14, NULL,        NULL,                   'Pricing'),
  (lt_suv,    'location',   'Location',            'LOCATION',TRUE,  15, 'e.g. Kampala', NULL,               'Contact'),
  (lt_suv,    'phone',      'Contact Phone',       'PHONE',   TRUE,  16, NULL,        NULL,                   'Contact'),
  (lt_suv,    'whatsapp',   'WhatsApp Number',     'PHONE',   FALSE, 17, NULL,        NULL,                   'Contact')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

-- Copy same fields to other car types
INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
SELECT lt_sedan, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group
  FROM advert_field_definitions WHERE listing_type_id = lt_suv
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
SELECT lt_hatchback, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group
  FROM advert_field_definitions WHERE listing_type_id = lt_suv
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
SELECT lt_pickup, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group
  FROM advert_field_definitions WHERE listing_type_id = lt_suv
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

-- Boda Boda fields
INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, section_group)
VALUES
  (lt_bodaboda, 'make',       'Brand',              'SELECT',  TRUE,  1, NULL,        'Bike Details'),
  (lt_bodaboda, 'model',      'Model',               'TEXT',    FALSE, 2, 'e.g. Honda CG 125', 'Bike Details'),
  (lt_bodaboda, 'year',       'Year',                'NUMBER',  TRUE,  3, NULL,        'Bike Details'),
  (lt_bodaboda, 'engine_size','Engine (cc)',          'NUMBER',  FALSE, 4, 'e.g. 125', 'Bike Details'),
  (lt_bodaboda, 'condition',  'Condition',           'SELECT',  TRUE,  5, NULL,        'Condition'),
  (lt_bodaboda, 'color',      'Color',               'TEXT',    FALSE, 6, NULL,        'Bike Details'),
  (lt_bodaboda, 'price',      'Asking Price (UGX)',  'CURRENCY',TRUE,  7, NULL,        'Pricing'),
  (lt_bodaboda, 'negotiable', 'Negotiable?',         'BOOLEAN', FALSE, 8, NULL,        'Pricing'),
  (lt_bodaboda, 'location',   'Location',            'LOCATION',TRUE,  9, NULL,        'Contact'),
  (lt_bodaboda, 'phone',      'Contact Phone',       'PHONE',   TRUE,  10, NULL,       'Contact')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

-- ─────────────────────────────────────────────
-- FIELD DEFINITIONS: REAL ESTATE (Apartment Rental)
-- ─────────────────────────────────────────────

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
VALUES
  (lt_apartment, 'bedrooms',    'Bedrooms',           'SELECT',  TRUE,  1, NULL,  NULL,         'Property Details'),
  (lt_apartment, 'bathrooms',   'Bathrooms',          'SELECT',  TRUE,  2, NULL,  NULL,         'Property Details'),
  (lt_apartment, 'size_sqft',   'Size (sqft)',        'NUMBER',  FALSE, 3, NULL,  'Approximate','Property Details'),
  (lt_apartment, 'furnished',   'Furnished?',         'SELECT',  TRUE,  4, NULL,  NULL,         'Property Details'),
  (lt_apartment, 'floor',       'Floor Level',        'NUMBER',  FALSE, 5, NULL,  NULL,         'Property Details'),
  (lt_apartment, 'parking',     'Parking Available?', 'BOOLEAN', FALSE, 6, NULL,  NULL,         'Amenities'),
  (lt_apartment, 'water',       'Water Supply',       'SELECT',  FALSE, 7, NULL,  NULL,         'Amenities'),
  (lt_apartment, 'security',    'Security?',          'BOOLEAN', FALSE, 8, NULL,  NULL,         'Amenities'),
  (lt_apartment, 'price',       'Monthly Rent (UGX)', 'CURRENCY',TRUE,  9, NULL,  NULL,         'Pricing'),
  (lt_apartment, 'negotiable',  'Negotiable?',        'BOOLEAN', FALSE, 10,NULL,  NULL,         'Pricing'),
  (lt_apartment, 'location',    'Location / Area',    'LOCATION',TRUE,  11,NULL,  NULL,         'Location'),
  (lt_apartment, 'phone',       'Contact Phone',      'PHONE',   TRUE,  12,NULL,  NULL,         'Contact'),
  (lt_apartment, 'whatsapp',    'WhatsApp',           'PHONE',   FALSE, 13,NULL,  NULL,         'Contact')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

-- Copy to hostel and other rental types
INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group)
SELECT lt_hostel, field_key, label, field_type, is_required, sort_order, placeholder, helper_text, section_group
  FROM advert_field_definitions WHERE listing_type_id = lt_apartment
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

-- Shop fields
INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, section_group)
VALUES
  (lt_shop, 'size_sqft',  'Size (sqft)',        'NUMBER',  FALSE, 1, NULL, 'Commercial Details'),
  (lt_shop, 'floor',      'Floor Level',        'NUMBER',  FALSE, 2, NULL, 'Commercial Details'),
  (lt_shop, 'parking',    'Parking Available?', 'BOOLEAN', FALSE, 3, NULL, 'Amenities'),
  (lt_shop, 'price',      'Monthly Rent (UGX)', 'CURRENCY',TRUE,  4, NULL, 'Pricing'),
  (lt_shop, 'negotiable', 'Negotiable?',        'BOOLEAN', FALSE, 5, NULL, 'Pricing'),
  (lt_shop, 'location',   'Location',           'LOCATION',TRUE,  6, NULL, 'Location'),
  (lt_shop, 'phone',      'Contact Phone',      'PHONE',   TRUE,  7, NULL, 'Contact')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

-- ─────────────────────────────────────────────
-- FIELD DEFINITIONS: PHONES
-- ─────────────────────────────────────────────

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, section_group)
VALUES
  (lt_iphone, 'model',       'Model',              'SELECT',  TRUE,  1, NULL,         'Phone Details'),
  (lt_iphone, 'storage',     'Storage',            'SELECT',  TRUE,  2, NULL,         'Specs'),
  (lt_iphone, 'ram',         'RAM',                'SELECT',  FALSE, 3, NULL,         'Specs'),
  (lt_iphone, 'color',       'Color',              'TEXT',    FALSE, 4, NULL,         'Phone Details'),
  (lt_iphone, 'condition',   'Condition',          'SELECT',  TRUE,  5, NULL,         'Condition'),
  (lt_iphone, 'battery',     'Battery Health (%)', 'NUMBER',  FALSE, 6, NULL,         'Condition'),
  (lt_iphone, 'network',     'Network',            'SELECT',  FALSE, 7, NULL,         'Phone Details'),
  (lt_iphone, 'price',       'Price (UGX)',        'CURRENCY',TRUE,  8, NULL,         'Pricing'),
  (lt_iphone, 'negotiable',  'Negotiable?',        'BOOLEAN', FALSE, 9, NULL,         'Pricing'),
  (lt_iphone, 'location',    'Location',           'LOCATION',TRUE,  10,NULL,         'Contact'),
  (lt_iphone, 'phone',       'Contact Phone',      'PHONE',   TRUE,  11,NULL,         'Contact')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

-- Samsung fields (similar, different model options)
INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, section_group)
SELECT lt_samsung, field_key, label, field_type, is_required, sort_order, placeholder, section_group
  FROM advert_field_definitions WHERE listing_type_id = lt_iphone
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, section_group)
SELECT lt_tecno, field_key, label, field_type, is_required, sort_order, placeholder, section_group
  FROM advert_field_definitions WHERE listing_type_id = lt_iphone
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, section_group)
SELECT lt_infinix, field_key, label, field_type, is_required, sort_order, placeholder, section_group
  FROM advert_field_definitions WHERE listing_type_id = lt_iphone
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

-- ─────────────────────────────────────────────
-- FIELD DEFINITIONS: EVENTS (Concert)
-- ─────────────────────────────────────────────

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, section_group)
VALUES
  (lt_concert_event, 'event_date',    'Event Date',           'DATE',    TRUE,  1, NULL, 'Event Info'),
  (lt_concert_event, 'event_time',    'Start Time',           'TEXT',    TRUE,  2, 'e.g. 6:00 PM', 'Event Info'),
  (lt_concert_event, 'venue',         'Venue Name',           'TEXT',    TRUE,  3, NULL, 'Event Info'),
  (lt_concert_event, 'venue_location','Venue Location',       'LOCATION',TRUE,  4, NULL, 'Event Info'),
  (lt_concert_event, 'artists',       'Performers / Artists', 'TEXTAREA',FALSE, 5, NULL, 'Event Info'),
  (lt_concert_event, 'ticket_price',  'Ticket Price (UGX)',   'CURRENCY',TRUE,  6, NULL, 'Tickets'),
  (lt_concert_event, 'ticket_url',    'Ticket Purchase Link', 'URL',     FALSE, 7, NULL, 'Tickets'),
  (lt_concert_event, 'capacity',      'Venue Capacity',       'NUMBER',  FALSE, 8, NULL, 'Tickets'),
  (lt_concert_event, 'dress_code',    'Dress Code',           'TEXT',    FALSE, 9, NULL, 'Details'),
  (lt_concert_event, 'phone',         'Organizer Phone',      'PHONE',   TRUE,  10,NULL, 'Contact'),
  (lt_concert_event, 'email',         'Organizer Email',      'EMAIL',   FALSE, 11,NULL, 'Contact'),
  (lt_concert_event, 'website',       'Event Website',        'URL',     FALSE, 12,NULL, 'Contact')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, section_group)
SELECT lt_conf_event, field_key, label, field_type, is_required, sort_order, placeholder, section_group
  FROM advert_field_definitions WHERE listing_type_id = lt_concert_event
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

-- ─────────────────────────────────────────────
-- FIELD DEFINITIONS: JOBS
-- ─────────────────────────────────────────────

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, section_group)
VALUES
  (lt_tech_job, 'company_name',     'Company Name',         'TEXT',    TRUE,  1, NULL,           'Job Details'),
  (lt_tech_job, 'job_title',        'Job Title',            'TEXT',    TRUE,  2, NULL,           'Job Details'),
  (lt_tech_job, 'salary_range',     'Salary Range (UGX)',   'TEXT',    FALSE, 3, 'e.g. 800,000 - 1,500,000', 'Compensation'),
  (lt_tech_job, 'employment_type',  'Employment Type',      'SELECT',  TRUE,  4, NULL,           'Job Details'),
  (lt_tech_job, 'experience_level', 'Experience Required',  'SELECT',  TRUE,  5, NULL,           'Requirements'),
  (lt_tech_job, 'education',        'Education Level',      'SELECT',  FALSE, 6, NULL,           'Requirements'),
  (lt_tech_job, 'deadline',         'Application Deadline', 'DATE',    FALSE, 7, NULL,           'Application'),
  (lt_tech_job, 'how_to_apply',     'How to Apply',         'TEXTAREA',TRUE,  8, NULL,           'Application'),
  (lt_tech_job, 'location',         'Work Location',        'LOCATION',TRUE,  9, NULL,           'Location'),
  (lt_tech_job, 'remote_ok',        'Remote Possible?',     'BOOLEAN', FALSE, 10,NULL,           'Location'),
  (lt_tech_job, 'phone',            'HR Contact Phone',     'PHONE',   FALSE, 11,NULL,           'Contact'),
  (lt_tech_job, 'email',            'Application Email',    'EMAIL',   FALSE, 12,NULL,           'Contact'),
  (lt_tech_job, 'website',          'Company Website',      'URL',     FALSE, 13,NULL,           'Contact')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, section_group)
SELECT lt_general_job, field_key, label, field_type, is_required, sort_order, placeholder, section_group
  FROM advert_field_definitions WHERE listing_type_id = lt_tech_job
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

-- ─────────────────────────────────────────────
-- FIELD DEFINITIONS: FASHION (Men's Wear)
-- ─────────────────────────────────────────────

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, section_group)
VALUES
  (lt_mens_wear, 'brand',     'Brand',          'TEXT',    FALSE, 1, NULL, 'Item Details'),
  (lt_mens_wear, 'size',      'Size',           'SELECT',  TRUE,  2, NULL, 'Item Details'),
  (lt_mens_wear, 'color',     'Color(s)',       'TEXT',    FALSE, 3, NULL, 'Item Details'),
  (lt_mens_wear, 'material',  'Material',       'TEXT',    FALSE, 4, NULL, 'Item Details'),
  (lt_mens_wear, 'condition', 'Condition',      'SELECT',  TRUE,  5, NULL, 'Condition'),
  (lt_mens_wear, 'price',     'Price (UGX)',    'CURRENCY',TRUE,  6, NULL, 'Pricing'),
  (lt_mens_wear, 'negotiable','Negotiable?',    'BOOLEAN', FALSE, 7, NULL, 'Pricing'),
  (lt_mens_wear, 'location',  'Location',       'LOCATION',TRUE,  8, NULL, 'Contact'),
  (lt_mens_wear, 'phone',     'Contact Phone',  'PHONE',   TRUE,  9, NULL, 'Contact'),
  (lt_mens_wear, 'whatsapp',  'WhatsApp',       'PHONE',   FALSE, 10,NULL, 'Contact')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, section_group)
SELECT lt_womens_wear, field_key, label, field_type, is_required, sort_order, placeholder, section_group
  FROM advert_field_definitions WHERE listing_type_id = lt_mens_wear
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

-- ─────────────────────────────────────────────
-- FIELD DEFINITIONS: SERVICES (Cleaning)
-- ─────────────────────────────────────────────

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, section_group)
VALUES
  (lt_cleaning, 'service_area',  'Service Area',     'LOCATION',TRUE,  1, NULL, 'Service Details'),
  (lt_cleaning, 'price_from',    'Starting Price',   'CURRENCY',FALSE, 2, NULL, 'Pricing'),
  (lt_cleaning, 'availability',  'Availability',     'TEXT',    FALSE, 3, 'e.g. Mon-Sat 8am-6pm', 'Schedule'),
  (lt_cleaning, 'phone',         'Contact Phone',    'PHONE',   TRUE,  4, NULL, 'Contact'),
  (lt_cleaning, 'whatsapp',      'WhatsApp',         'PHONE',   FALSE, 5, NULL, 'Contact'),
  (lt_cleaning, 'email',         'Email',            'EMAIL',   FALSE, 6, NULL, 'Contact')
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

INSERT INTO advert_field_definitions
  (listing_type_id, field_key, label, field_type, is_required, sort_order, placeholder, section_group)
SELECT lt_repair, field_key, label, field_type, is_required, sort_order, placeholder, section_group
  FROM advert_field_definitions WHERE listing_type_id = lt_cleaning
ON CONFLICT (listing_type_id, field_key) DO NOTHING;

-- ─────────────────────────────────────────────
-- FIELD OPTIONS (Dropdown values)
-- ─────────────────────────────────────────────

-- Vehicle Make options
WITH car_make_fields AS (
  SELECT fd.id FROM advert_field_definitions fd
  WHERE fd.field_key = 'make'
    AND fd.listing_type_id IN (lt_suv, lt_sedan, lt_hatchback, lt_pickup)
)
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT f.id, v.option_value, v.option_label, v.sort_order
FROM car_make_fields f
CROSS JOIN (VALUES
  ('toyota','Toyota',1), ('nissan','Nissan',2), ('honda','Honda',3),
  ('mitsubishi','Mitsubishi',4), ('subaru','Subaru',5), ('mercedes','Mercedes-Benz',6),
  ('bmw','BMW',7), ('volkswagen','Volkswagen',8), ('ford','Ford',9),
  ('hyundai','Hyundai',10), ('kia','Kia',11), ('mazda','Mazda',12),
  ('suzuki','Suzuki',13), ('isuzu','Isuzu',14), ('land_rover','Land Rover',15),
  ('jeep','Jeep',16), ('peugeot','Peugeot',17), ('other','Other',18)
) AS v(option_value, option_label, sort_order)
ON CONFLICT DO NOTHING;

-- Fuel type options
WITH fuel_fields AS (
  SELECT fd.id FROM advert_field_definitions fd WHERE fd.field_key = 'fuel_type'
)
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT f.id, v.option_value, v.option_label, v.sort_order
FROM fuel_fields f
CROSS JOIN (VALUES
  ('petrol','Petrol',1),('diesel','Diesel',2),('electric','Electric',3),
  ('hybrid','Hybrid',4),('lpg','LPG',5)
) AS v(option_value, option_label, sort_order)
ON CONFLICT DO NOTHING;

-- Transmission options
WITH trans_fields AS (
  SELECT fd.id FROM advert_field_definitions fd WHERE fd.field_key = 'transmission'
)
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT f.id, v.option_value, v.option_label, v.sort_order
FROM trans_fields f
CROSS JOIN (VALUES
  ('automatic','Automatic',1),('manual','Manual',2),('semi_auto','Semi-Automatic',3)
) AS v(option_value, option_label, sort_order)
ON CONFLICT DO NOTHING;

-- Condition options
WITH cond_fields AS (
  SELECT fd.id FROM advert_field_definitions fd WHERE fd.field_key = 'condition'
)
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT f.id, v.option_value, v.option_label, v.sort_order
FROM cond_fields f
CROSS JOIN (VALUES
  ('new','Brand New',1),('foreign_used','Foreign Used',2),('local_used','Local Used',3),
  ('for_parts','For Parts',4)
) AS v(option_value, option_label, sort_order)
ON CONFLICT DO NOTHING;

-- Drive type options
WITH drive_fields AS (
  SELECT fd.id FROM advert_field_definitions fd WHERE fd.field_key = 'drive_type'
)
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT f.id, v.option_value, v.option_label, v.sort_order
FROM drive_fields f
CROSS JOIN (VALUES
  ('2wd','2WD',1),('4wd','4WD',2),('awd','AWD',3)
) AS v(option_value, option_label, sort_order)
ON CONFLICT DO NOTHING;

-- Door options
WITH door_fields AS (
  SELECT fd.id FROM advert_field_definitions fd WHERE fd.field_key = 'doors'
)
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT f.id, v.option_value, v.option_label, v.sort_order
FROM door_fields f
CROSS JOIN (VALUES ('2','2 Doors',1),('3','3 Doors',2),('4','4 Doors',3),('5','5 Doors',4))
AS v(option_value, option_label, sort_order)
ON CONFLICT DO NOTHING;

-- Bedroom options
WITH bed_fields AS (
  SELECT fd.id FROM advert_field_definitions fd WHERE fd.field_key = 'bedrooms'
)
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT f.id, v.option_value, v.option_label, v.sort_order
FROM bed_fields f
CROSS JOIN (VALUES
  ('self_contained','Self Contained',1),('1','1 Bedroom',2),('2','2 Bedrooms',3),
  ('3','3 Bedrooms',4),('4','4 Bedrooms',5),('5+','5+ Bedrooms',6)
) AS v(option_value, option_label, sort_order)
ON CONFLICT DO NOTHING;

-- Bathroom options
WITH bath_fields AS (
  SELECT fd.id FROM advert_field_definitions fd WHERE fd.field_key = 'bathrooms'
)
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT f.id, v.option_value, v.option_label, v.sort_order
FROM bath_fields f
CROSS JOIN (VALUES ('1','1',1),('2','2',2),('3','3',3),('4+','4+',4))
AS v(option_value, option_label, sort_order)
ON CONFLICT DO NOTHING;

-- Furnished options
WITH furn_fields AS (
  SELECT fd.id FROM advert_field_definitions fd WHERE fd.field_key = 'furnished'
)
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT f.id, v.option_value, v.option_label, v.sort_order
FROM furn_fields f
CROSS JOIN (VALUES
  ('furnished','Fully Furnished',1),('semi','Semi Furnished',2),('unfurnished','Unfurnished',3)
) AS v(option_value, option_label, sort_order)
ON CONFLICT DO NOTHING;

-- Storage options (phones)
WITH storage_fields AS (
  SELECT fd.id FROM advert_field_definitions fd WHERE fd.field_key = 'storage'
)
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT f.id, v.option_value, v.option_label, v.sort_order
FROM storage_fields f
CROSS JOIN (VALUES
  ('16gb','16 GB',1),('32gb','32 GB',2),('64gb','64 GB',3),
  ('128gb','128 GB',4),('256gb','256 GB',5),('512gb','512 GB',6),('1tb','1 TB',7)
) AS v(option_value, option_label, sort_order)
ON CONFLICT DO NOTHING;

-- RAM options
WITH ram_fields AS (
  SELECT fd.id FROM advert_field_definitions fd WHERE fd.field_key = 'ram'
)
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT f.id, v.option_value, v.option_label, v.sort_order
FROM ram_fields f
CROSS JOIN (VALUES
  ('2gb','2 GB',1),('3gb','3 GB',2),('4gb','4 GB',3),
  ('6gb','6 GB',4),('8gb','8 GB',5),('12gb','12 GB',6),('16gb','16 GB',7)
) AS v(option_value, option_label, sort_order)
ON CONFLICT DO NOTHING;

-- Network options (phones)
WITH net_fields AS (
  SELECT fd.id FROM advert_field_definitions fd WHERE fd.field_key = 'network'
)
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT f.id, v.option_value, v.option_label, v.sort_order
FROM net_fields f
CROSS JOIN (VALUES ('2g','2G',1),('3g','3G',2),('4g','4G',3),('5g','5G',4))
AS v(option_value, option_label, sort_order)
ON CONFLICT DO NOTHING;

-- Clothing size options
WITH size_fields AS (
  SELECT fd.id FROM advert_field_definitions fd WHERE fd.field_key = 'size'
)
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT f.id, v.option_value, v.option_label, v.sort_order
FROM size_fields f
CROSS JOIN (VALUES
  ('xs','XS',1),('s','S',2),('m','M',3),('l','L',4),
  ('xl','XL',5),('xxl','XXL',6),('xxxl','XXXL',7)
) AS v(option_value, option_label, sort_order)
ON CONFLICT DO NOTHING;

-- Employment type options
WITH emp_fields AS (
  SELECT fd.id FROM advert_field_definitions fd WHERE fd.field_key = 'employment_type'
)
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT f.id, v.option_value, v.option_label, v.sort_order
FROM emp_fields f
CROSS JOIN (VALUES
  ('full_time','Full-Time',1),('part_time','Part-Time',2),
  ('contract','Contract',3),('internship','Internship',4),('volunteer','Volunteer',5)
) AS v(option_value, option_label, sort_order)
ON CONFLICT DO NOTHING;

-- Experience level options
WITH exp_fields AS (
  SELECT fd.id FROM advert_field_definitions fd WHERE fd.field_key = 'experience_level'
)
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT f.id, v.option_value, v.option_label, v.sort_order
FROM exp_fields f
CROSS JOIN (VALUES
  ('entry','Entry Level (0-1 yr)',1),('junior','Junior (1-2 yrs)',2),
  ('mid','Mid-Level (3-5 yrs)',3),('senior','Senior (5+ yrs)',4),
  ('executive','Executive',5)
) AS v(option_value, option_label, sort_order)
ON CONFLICT DO NOTHING;

-- Education level options
WITH edu_fields AS (
  SELECT fd.id FROM advert_field_definitions fd WHERE fd.field_key = 'education'
)
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT f.id, v.option_value, v.option_label, v.sort_order
FROM edu_fields f
CROSS JOIN (VALUES
  ('none','No Requirement',1),('o_level','O-Level / UACE',2),
  ('diploma','Diploma',3),('bachelors','Bachelors Degree',4),
  ('masters','Masters Degree',5),('phd','PhD',6)
) AS v(option_value, option_label, sort_order)
ON CONFLICT DO NOTHING;

-- Water supply options
WITH water_fields AS (
  SELECT fd.id FROM advert_field_definitions fd WHERE fd.field_key = 'water'
)
INSERT INTO advert_field_options (field_def_id, option_value, option_label, sort_order)
SELECT f.id, v.option_value, v.option_label, v.sort_order
FROM water_fields f
CROSS JOIN (VALUES
  ('nwsc','NWSC (Tap Water)',1),('borehole','Borehole',2),
  ('tank','Water Tank',3),('none','No Piped Water',4)
) AS v(option_value, option_label, sort_order)
ON CONFLICT DO NOTHING;

END $$;
