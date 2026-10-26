ALTER TABLE practiceSettings ADD COLUMN difficulties TEXT NOT NULL DEFAULT '[0]'
    CHECK (json_valid(difficulties) AND json_type(difficulties)='array'
        AND json_array_length(difficulties) BETWEEN 1 AND 3);
UPDATE practiceSettings SET difficulties=json_array(difficulty);
