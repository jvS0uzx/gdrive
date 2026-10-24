from alembic import op

revision = "0004"
down_revision = "0003"

STATEMENTS = [
    "ALTER TABLE stores ADD COLUMN manual boolean NOT NULL DEFAULT false",
    "CREATE INDEX stores_name ON stores (lower(name))",
    """
    CREATE TABLE tracks (
        order_id bigint NOT NULL REFERENCES orders (id),
        phase text NOT NULL CHECK (phase IN ('loja', 'cliente')),
        courier_id integer REFERENCES couriers (id),
        geom geometry(LineStringM, 4326) NOT NULL,
        meters double precision NOT NULL,
        planned geometry(LineString, 4326),
        planned_seconds double precision,
        planned_meters double precision,
        PRIMARY KEY (order_id, phase)
    )
    """,
    "CREATE INDEX orders_delivered ON orders (delivered_at DESC) WHERE status = 'entregue'",
]


def upgrade():
    for statement in STATEMENTS:
        op.execute(statement)


def downgrade():
    op.execute("DROP INDEX orders_delivered")
    op.execute("DROP TABLE tracks")
    op.execute("DROP INDEX stores_name")
    op.execute("ALTER TABLE stores DROP COLUMN manual")
