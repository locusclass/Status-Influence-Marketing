-- Add observer mode flag to admin_users
-- Observer admins can view all dashboard data but cannot take actions
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS is_observer BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN admin_users.is_observer IS 'When true, this admin can view dashboard data but all action buttons are disabled';
