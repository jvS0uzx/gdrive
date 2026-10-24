from alembic import op

revision = "0002"
down_revision = "0001"


def upgrade():
    op.execute("ALTER TABLE offers ADD COLUMN candidates jsonb NOT NULL DEFAULT '[]'")


def downgrade():
    op.execute("ALTER TABLE offers DROP COLUMN candidates")
