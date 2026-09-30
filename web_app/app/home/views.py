import platform
from datetime import datetime, timezone

from flask import jsonify, render_template
from . import home


@home.route("/")
def homepage():
    """
    Render the homepage template on the / route
    """
    return render_template("page/home/index.html", title="Welcome")


@home.route("/dashboard")
def dashboard():
    """
    Render the dashboard template on the /dashboard route
    """
    return render_template("page/home/dashboard.html", title="Dashboard")


@home.route("/api/system-info", methods=["GET"])
def system_info():
    """
    Return basic information about the Python runtime as JSON.
    """
    return jsonify(
        python_version=platform.python_version(),
        implementation=platform.python_implementation(),
        platform=platform.platform(),
        timestamp=datetime.now(timezone.utc).isoformat(),
    )
