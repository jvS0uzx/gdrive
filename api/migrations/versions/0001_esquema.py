from alembic import op

revision = "0001"
down_revision = None

ACTIVE = "('a_caminho_da_loja', 'na_loja', 'em_rota', 'no_cliente')"

STATEMENTS = [
    "CREATE EXTENSION IF NOT EXISTS postgis",
    """
    CREATE TABLE addresses (
        id serial PRIMARY KEY,
        node_id integer NOT NULL,
        kind text NOT NULL CHECK (kind IN ('customer', 'store', 'courier_home')),
        lat double precision NOT NULL,
        lon double precision NOT NULL,
        geom geometry(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon, lat), 4326)) STORED
    )
    """,
    "CREATE INDEX addresses_geom ON addresses USING gist (geom)",
    "CREATE INDEX addresses_kind ON addresses (kind)",
    """
    CREATE TABLE stores (
        id serial PRIMARY KEY,
        name text NOT NULL,
        address_id integer NOT NULL REFERENCES addresses (id),
        default_prep_minutes integer NOT NULL DEFAULT 15
    )
    """,
    """
    CREATE TABLE couriers (
        id serial PRIMARY KEY,
        name text NOT NULL,
        home_address_id integer NOT NULL REFERENCES addresses (id),
        status text NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'livre', 'ocupado')),
        human boolean NOT NULL DEFAULT false
    )
    """,
    """
    CREATE TABLE orders (
        id bigserial PRIMARY KEY,
        store_id integer NOT NULL REFERENCES stores (id),
        address_id integer NOT NULL REFERENCES addresses (id),
        status text NOT NULL CHECK (status IN ('aguardando_loja', 'em_preparo', 'a_caminho_da_loja', 'na_loja',
            'em_rota', 'no_cliente', 'entregue', 'recusado', 'cancelado')),
        courier_id integer REFERENCES couriers (id),
        version integer NOT NULL DEFAULT 1,
        prep_minutes integer,
        ready_at timestamptz,
        promised_at timestamptz,
        dispatch_radius_m integer NOT NULL DEFAULT 2000,
        dispatch_started_at timestamptz,
        unassigned_alerted boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    f"CREATE UNIQUE INDEX orders_one_active_per_courier ON orders (courier_id) WHERE status IN {ACTIVE}",
    "CREATE INDEX orders_status ON orders (status)",
    """
    CREATE TABLE order_events (
        id bigserial PRIMARY KEY,
        order_id bigint NOT NULL REFERENCES orders (id),
        type text NOT NULL,
        status text NOT NULL,
        actor text NOT NULL,
        at timestamptz NOT NULL DEFAULT now()
    )
    """,
    "CREATE INDEX order_events_order ON order_events (order_id, id)",
    """
    CREATE TABLE offers (
        id bigserial PRIMARY KEY,
        order_id bigint NOT NULL REFERENCES orders (id),
        courier_id integer NOT NULL REFERENCES couriers (id),
        status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'aceita', 'recusada', 'expirada')),
        radius_m integer NOT NULL,
        eta_seconds double precision NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
    )
    """,
    "CREATE UNIQUE INDEX offers_one_pending_per_order ON offers (order_id) WHERE status = 'pendente'",
    "CREATE UNIQUE INDEX offers_one_pending_per_courier ON offers (courier_id) WHERE status = 'pendente'",
    "CREATE INDEX offers_order ON offers (order_id)",
    """
    CREATE TABLE outbox (
        id bigserial PRIMARY KEY,
        topic text NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz
    )
    """,
    "CREATE INDEX outbox_pending ON outbox (id) WHERE published_at IS NULL",
    """
    CREATE TABLE jobs (
        id bigserial PRIMARY KEY,
        kind text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}',
        run_at timestamptz NOT NULL DEFAULT now(),
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        done_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    "CREATE INDEX jobs_due ON jobs (run_at) WHERE done_at IS NULL",
]


def upgrade():
    for statement in STATEMENTS:
        op.execute(statement)


def downgrade():
    for table in ["jobs", "outbox", "offers", "order_events", "orders", "couriers", "stores", "addresses"]:
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
