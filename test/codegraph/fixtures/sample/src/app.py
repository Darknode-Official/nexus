from .helpers import run
class App:
    def start(self):
        return run()
def main():
    return App().start()
__all__ = ["App", "main"]
