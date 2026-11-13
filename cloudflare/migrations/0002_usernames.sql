-- A name each guest can choose in Settings. NULL shows the default "Guest xxxxxxxx".
ALTER TABLE users ADD COLUMN display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 40);
