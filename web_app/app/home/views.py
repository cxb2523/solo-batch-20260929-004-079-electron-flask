import os
import platform
import sys
from datetime import datetime, timezone

from flask import abort, jsonify, render_template, send_from_directory
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
    Return information about the Python interpreter running the backend.
    """
    return jsonify(
        {
            "python_version": platform.python_version(),
            "python_implementation": platform.python_implementation(),
            "platform": platform.platform(),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    )


def _root_file_candidates(filename):
    """
    Resolve files that live at the repository root in development and at the
    PyInstaller bundle root (``sys._MEIPASS``) in production.
    """
    repo_root = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "..")
    )
    candidates = [os.path.join(repo_root, filename)]
    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root:
        candidates.append(os.path.join(bundle_root, filename))
    return candidates


@home.route("/renderer.js", methods=["GET"])
def renderer_script():
    """
    Serve the browser side renderer script bundled next to the app entry.
    """
    for candidate in _root_file_candidates("renderer.js"):
        if os.path.isfile(candidate):
            return send_from_directory(
                os.path.dirname(candidate),
                os.path.basename(candidate),
                mimetype="application/javascript",
            )
    abort(404)
